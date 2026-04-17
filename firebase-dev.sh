#!/bin/bash

# Convenience script for Firebase development
# Make sure you have the FIREBASE_TOKEN environment variable set

# Set Firebase environment variables
export FUNCTIONS_DISCOVERY_TIMEOUT=30
export GOOGLE_APPLICATION_CREDENTIALS="/mnt/c/Users/marko-pc/Desktop/git/web-mtg-life-clicker/web-mtg-life-clicker-409305bd6744.json"

if [ -z "$FIREBASE_TOKEN" ]; then
    echo "Error: FIREBASE_TOKEN environment variable is not set"
    echo "Please run: source ~/.bashrc"
    exit 1
fi

# Function to check and kill processes using Firebase emulator ports
kill_port_processes() {
    echo "🔍 Checking for processes using Firebase emulator ports..."
    
    # Check port 8080 (Firestore emulator)
    FIRESTORE_PID=$(lsof -ti :8080 2>/dev/null)
    if [ ! -z "$FIRESTORE_PID" ]; then
        echo "⚠️  Killing process using port 8080 (PID: $FIRESTORE_PID)"
        kill -9 $FIRESTORE_PID 2>/dev/null
    fi
    
    # Check port 9099 (Auth emulator)
    AUTH_PID=$(lsof -ti :9099 2>/dev/null)
    if [ ! -z "$AUTH_PID" ]; then
        echo "⚠️  Killing process using port 9099 (PID: $AUTH_PID)"
        kill -9 $AUTH_PID 2>/dev/null
    fi
    
    # Check port 5001 (Functions emulator)
    FUNCTIONS_PID=$(lsof -ti :5001 2>/dev/null)
    if [ ! -z "$FUNCTIONS_PID" ]; then
        echo "⚠️  Killing process using port 5001 (PID: $FUNCTIONS_PID)"
        kill -9 $FUNCTIONS_PID 2>/dev/null
    fi
    
    # Check port 5000 (Hosting emulator)
    HOSTING_PID=$(lsof -ti :5000 2>/dev/null)
    if [ ! -z "$HOSTING_PID" ]; then
        echo "⚠️  Killing process using port 5000 (PID: $HOSTING_PID)"
        kill -9 $HOSTING_PID 2>/dev/null
    fi
    
    # Check port 4000 (Emulator UI)
    UI_PID=$(lsof -ti :4000 2>/dev/null)
    if [ ! -z "$UI_PID" ]; then
        echo "⚠️  Killing process using port 4000 (PID: $UI_PID)"
        kill -9 $UI_PID 2>/dev/null
    fi
    
    echo "✅ Port cleanup complete"
    sleep 1
}

echo "🔥 Firebase Development Script"
echo "Available commands:"
echo "  start-emulators  - Start Firebase emulators"
echo "  test-functions   - Test Firebase functions locally"
echo "  deploy-functions - Deploy functions to Firebase"
echo "  deploy-hosting   - Deploy hosting to Firebase"
echo "  deploy-all       - Deploy everything to Firebase"
echo "  serve-hosting    - Serve hosting locally"
echo ""

case "$1" in
    "start-emulators")
        echo "Starting Firebase emulators..."
        kill_port_processes
        firebase emulators:start --token "$FIREBASE_TOKEN"
        ;;
    "test-functions")
        echo "Testing Firebase functions locally..."
        cd functions && npm run serve
        ;;
    "deploy-functions")
        echo "Deploying Firebase functions..."
        firebase deploy --only functions --token "$FIREBASE_TOKEN"
        ;;
    "deploy-hosting")
        echo "Deploying Firebase hosting..."
        firebase deploy --only hosting --token "$FIREBASE_TOKEN"
        ;;
    "deploy-all")
        echo "Deploying everything to Firebase..."
        firebase deploy --token "$FIREBASE_TOKEN"
        ;;
    "serve-hosting")
        echo "Serving hosting locally..."
        firebase serve --only hosting --token "$FIREBASE_TOKEN"
        ;;
    *)
        echo "Usage: $0 {start-emulators|test-functions|deploy-functions|deploy-hosting|deploy-all|serve-hosting}"
        exit 1
        ;;
esac
