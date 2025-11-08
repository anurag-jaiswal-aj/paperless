#!/bin/bash

# Paperless Setup Script
# This script installs dependencies for both client and server

echo "🚀 Setting up Paperless..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null
then
    echo "❌ Node.js is not installed. Please install Node.js v18 or higher."
    exit 1
fi

echo "✅ Node.js version: $(node -v)"
echo ""

# Install server dependencies
echo "📦 Installing server dependencies..."
cd server
npm install

if [ $? -eq 0 ]; then
    echo "✅ Server dependencies installed"
else
    echo "❌ Failed to install server dependencies"
    exit 1
fi

cd ..

# Install client dependencies
echo ""
echo "📦 Installing client dependencies..."
cd client
npm install

if [ $? -eq 0 ]; then
    echo "✅ Client dependencies installed"
else
    echo "❌ Failed to install client dependencies"
    exit 1
fi

cd ..

echo ""
echo "✅ Setup complete!"
echo ""
echo "📝 Next steps:"
echo "1. Add your MongoDB URI to server/.env"
echo "2. Add your OpenAI API key to server/.env (optional)"
echo "3. Run 'npm run server' in one terminal"
echo "4. Run 'npm run client' in another terminal"
echo ""
echo "🎉 Happy coding!"
