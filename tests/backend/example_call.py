"""Example / template: call one callable against the emulator and print its
result as JSON. Copy this for a one-off check rather than editing it in
place, or just import emulator_helpers directly in a scratch script.

    functions/venv/bin/python tests/backend/example_call.py get_club_roster '{"query": "BC Trier"}'
"""
import json
import sys

sys.path.insert(0, "functions")
sys.path.insert(0, "tests/backend")

import main  # noqa: E402
from emulator_helpers import call_callable  # noqa: E402

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <callable_name> '<json_data>'")
        print("example: python tests/backend/example_call.py get_club_roster '{\"query\": \"BC Trier\"}'")
        sys.exit(1)

    fn = getattr(main, sys.argv[1])
    data = json.loads(sys.argv[2])
    result = call_callable(fn, data)
    print(json.dumps(result, indent=2, default=str, ensure_ascii=False))
