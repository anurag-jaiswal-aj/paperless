@echo off
REM Paperless Setup Script for Windows
REM This script installs dependencies for both client and server

echo.
echo 🚀 Setting up Paperless...
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Node.js is not installed. Please install Node.js v18 or higher.
    pause
    exit /b 1
)

echo ✅ Node.js is installed
node -v
echo.

REM Install server dependencies
echo 📦 Installing server dependencies...
cd server
call npm install

if %errorlevel% neq 0 (
    echo ❌ Failed to install server dependencies
    pause
    exit /b 1
)

echo ✅ Server dependencies installed
cd ..

REM Install client dependencies
echo.
echo 📦 Installing client dependencies...
cd client
call npm install

if %errorlevel% neq 0 (
    echo ❌ Failed to install client dependencies
    pause
    exit /b 1
)

echo ✅ Client dependencies installed
cd ..

echo.
echo ✅ Setup complete!
echo.
echo 📝 Next steps:
echo 1. Add your MongoDB URI to server\.env
echo 2. Add your OpenAI API key to server\.env (optional)
echo 3. Run 'npm run server' in one terminal
echo 4. Run 'npm run client' in another terminal
echo.
echo 🎉 Happy coding!
echo.
pause
