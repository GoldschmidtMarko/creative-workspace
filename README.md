# Creative Workspace

A modern, AI-powered web application for creative professionals, built with Firebase and Python.

**Live app:** [creative-workspace-359a0.web.app](https://creative-workspace-359a0.web.app/)

## Features

- **AI-Powered Tools**: Integrated AI capabilities for creative tasks.
- **Firebase Backend**: Secure authentication and database management via Cloud Functions (Python) and Firestore.
- **BAX Checker**: Scrapes tournament player data and computes BAX values, with Firestore-backed caching.
- **Modern UI**: Clean, responsive dashboard with dedicated Analytics, Profile, and Settings views.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- [Python](https://www.python.org/) (v3.12 or higher)

### Installation

1.  **Clone the repository**
    ```bash
    git clone <repository-url>
    cd creative-workspace
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

### Development & Deployment

All local development and deployment tasks are run through [firebase-dev.sh](firebase-dev.sh):

```bash
./firebase-dev.sh start-emulators   # Start local emulators (hosting, functions, auth, firestore)
./firebase-dev.sh test-functions    # Test functions locally
./firebase-dev.sh serve-hosting     # Serve hosting locally
./firebase-dev.sh deploy-functions  # Deploy functions only
./firebase-dev.sh deploy-hosting    # Deploy hosting only
./firebase-dev.sh deploy-all        # Deploy everything
```

See the script for the required environment setup (`FIREBASE_TOKEN` and `GOOGLE_APPLICATION_CREDENTIALS`).

## Project Structure

```
creative-workspace/
├── functions/          # Firebase Cloud Functions (Python)
├── public/             # Static website files
├── .agents/            # AI agent configurations
├── firebase.json       # Firebase configuration
└── .firebaserc         # Firebase project aliases
```

## License

[MIT](LICENSE)