#!/usr/bin/env bash
set -o errexit

echo "Installing dependencies..."
npm install

echo "Installing Chrome for Puppeteer..."
npx puppeteer browsers install chrome

echo "Running build..."
npm run build

echo "Build completed!"
