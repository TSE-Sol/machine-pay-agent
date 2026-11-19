#!/bin/bash
# Machine Pay Agent: double-click this file (macOS) to start the whole demo.
# It starts the server, the public tunnel and the agent in this window, and opens the
# dashboard in Google Chrome once the server is healthy. Ctrl+C stops everything.
cd "$(dirname "$0")" || exit 1

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install Node.js 20 or newer, then try again."
else
  npm run start:all -- --open
fi

echo
read -n 1 -s -r -p "The demo has stopped. Press any key to close this window."
echo
