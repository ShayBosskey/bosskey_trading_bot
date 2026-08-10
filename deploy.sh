#!/bin/bash
set -e
echo "🚀 Staging code for GitHub deployment..."
git add .
git commit -m "Architecture update: OOP migration and Gemini integration"
git push -u origin main
echo "✅ Deployment successful. Codebase secured."
