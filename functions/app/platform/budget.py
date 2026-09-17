"""Automated budget backstop.

GCP budgets are informational only - hitting 100% just sends an email, it
never stops spend on its own. budget_guard is a Pub/Sub handler a Cloud
Billing budget notification is wired to (see the gcloud/REST setup that
links the budget's notification to the 'budget-alerts' topic); once spend
reaches the budget, it scales every other function's max instance count to
zero so Cloud Functions stop accepting new invocations.
restore_function_capacity is the (admin-only) way back once the underlying
cost issue has been investigated.

Uses the Cloud Functions Admin API (v2) rather than the Cloud Run API that
actually backs Gen2 functions, so every call can reference functions by the
exact ids already used everywhere else in this repo (main.py's exports)
instead of guessing at Firebase's function-id -> Cloud Run service-id
transform (confirmed elsewhere: Cloud Run lowercases service names, which
would make a Cloud Run-based approach fragile).
"""

from firebase_functions import https_fn, pubsub_fn
from google.cloud import functions_v2
from google.protobuf import field_mask_pb2

from app.core.auth import Err, authenticate_user
from app.platform.admin import _is_admin

PROJECT_ID = "creative-workspace-359a0"
REGION = "europe-west3"
NORMAL_MAX_INSTANCES = 10  # matches set_global_options in app/core/firebase_app.py

# Never scaled down: budget_guard must stay invokable to run at all, and
# restore_function_capacity is the only way back once everything else is at zero.
_PROTECTED_FUNCTIONS = {"budget_guard", "restore_function_capacity"}


def _set_max_instances(max_instances: int) -> dict:
    client = functions_v2.FunctionServiceClient()
    parent = client.common_location_path(PROJECT_ID, REGION)

    updated = []
    skipped = []
    failed = []
    for function in client.list_functions(parent=parent):
        function_id = function.name.rsplit("/", 1)[-1]
        if function_id in _PROTECTED_FUNCTIONS:
            skipped.append(function_id)
            continue

        function.service_config.max_instance_count = max_instances
        try:
            client.update_function(
                function=function,
                update_mask=field_mask_pb2.FieldMask(paths=["service_config.max_instance_count"]),
            )
            updated.append(function_id)
        except Exception as error:
            # One function already mid-update (e.g. a previous run still
            # DEPLOYING) shouldn't stop the rest from being attempted.
            print(f"_set_max_instances: failed to update {function_id}: {error}")
            failed.append(function_id)

    return {"updated": updated, "skipped": skipped, "failed": failed}


@pubsub_fn.on_message_published(topic="budget-alerts")
def budget_guard(event: pubsub_fn.CloudEvent) -> None:
    payload = event.data.message.json or {}
    cost = payload.get("costAmount")
    budget = payload.get("budgetAmount")

    print(f"budget_guard: costAmount={cost} budgetAmount={budget}")

    if not budget or cost is None or cost / budget < 1.0:
        return

    result = _set_max_instances(0)
    print(f"budget_guard: budget exceeded, scaled to zero: {result['updated']}"
          + (f" (FAILED: {result['failed']})" if result["failed"] else ""))


@https_fn.on_call()
def restore_function_capacity(req: https_fn.CallableRequest) -> dict:
    """Admin-only recovery from budget_guard: puts every function back to
    the normal max-instance count."""
    authenticate_user(req.auth)
    if not _is_admin(req):
        raise https_fn.HttpsError(Err.PERMISSION_DENIED, "Not authorized.")

    result = _set_max_instances(NORMAL_MAX_INSTANCES)
    return {
        "message": f"Restored {len(result['updated'])} functions to max_instance_count={NORMAL_MAX_INSTANCES}.",
        **result,
    }
