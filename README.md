# Creative Workspace

A modern, AI-powered web application for creative professionals, built with Firebase and Python.

## Features

- **AI-Powered Tools**: Integrated AI capabilities for creative tasks.
- **Firebase Backend**: Secure authentication and database management.
- **Modern UI**: Clean, responsive user interface.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- [Python](https://www.python.org/) (v3.12 or higher)
- [Firebase CLI](https://firebase.google.com/docs/cli)

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

3.  **Set up Firebase**
    - Ensure you are logged in: `firebase login`
    - Initialize Firebase (if not already done): `firebase init`
    - Configure your project: `firebase use <project-id>`

### Development

Start the local development server:

```bash
firebase emulators:start
```

This will start the Firebase emulators for hosting, functions, and authentication.

### Deployment

Deploy your application to Firebase Hosting:

```bash
firebase deploy
```

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