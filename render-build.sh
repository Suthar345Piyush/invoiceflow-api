#!/usr/bin/env bash
set -o errexit

echo "Installing Chrome for Puppeteer..."
npx puppeteer browsers install chrome

echo "Running TypeScript build..."
npm run build

echo "Build completed!"
