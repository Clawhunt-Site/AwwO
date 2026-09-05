#!/bin/bash
# Art Chat Orchestrator - Start Script

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
SECRETS_FILE="$HOME/.openclaw/personal-secrets.json"

# Load GEMINI_API_KEY
export GEMINI_API_KEY=$(python3 -c "import json; print(json.load(open('$SECRETS_FILE')).get('GEMINI_API_KEY',''))")

if [ -z "$GEMINI_API_KEY" ]; then
    echo "❌ GEMINI_API_KEY not found in $SECRETS_FILE"
    exit 1
fi

echo "🎨 Starting Art Chat Orchestrator..."

# Kill existing if running
pkill -f "uvicorn main:app.*8090" 2>/dev/null
sleep 1

# Build frontend if needed
if [ ! -d "$REPO_DIR/frontend/dist" ]; then
    echo "📦 Building frontend..."
    cd "$REPO_DIR/frontend" && npx vite build
fi

# Start backend (serves frontend too)
cd "$PROJECT_DIR/backend"
echo "🚀 Starting backend on port 8090..."
nohup python3 -m uvicorn main:app --host 0.0.0.0 --port 8090 > /tmp/art-backend.log 2>&1 &
echo "Backend PID: $!"

sleep 2
if curl -s http://localhost:8090/api/health > /dev/null; then
    echo "✅ Art Chat Orchestrator running at http://localhost:8090"
    echo "📺 Access via noVNC: http://16.148.154.33:18864/vnc.html"
else
    echo "❌ Failed to start. Check /tmp/art-backend.log"
    exit 1
fi
