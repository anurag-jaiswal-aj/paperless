# 🔧 Paperless - Command Reference

Quick reference for all commands you'll need.

---

## 📦 Installation Commands

### Automated Setup
```bash
# macOS / Linux
./setup.sh

# Windows
setup.bat

# Cross-platform
npm run install:all
```

### Manual Setup
```bash
# Install server dependencies
cd server
npm install

# Install client dependencies
cd client
npm install
```

---

## 🚀 Development Commands

### Start Both Servers (2 terminals required)

**Terminal 1 - Backend:**
```bash
cd server
npm run dev
```

**Terminal 2 - Frontend:**
```bash
cd client
npm run dev
```

### Alternative (from root)
```bash
# Terminal 1
npm run server

# Terminal 2
npm run client
```

---

## 🏗️ Build Commands

### Frontend Production Build
```bash
cd client
npm run build
```

### Preview Production Build
```bash
cd client
npm run preview
```

### Backend Production Start
```bash
cd server
npm start
```

---

## 🔍 Testing Commands

### Check Server Health
```bash
curl http://localhost:5000/health
```

### Check MongoDB Connection
```bash
# In server directory
node -e "require('dotenv').config(); console.log(process.env.MONGO_URI)"
```

### Test API Endpoints
```bash
# Register
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@test.com","password":"test123"}'

# Login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test123"}'
```

---

## 🧹 Cleanup Commands

### Clear Node Modules
```bash
# Server
cd server
rm -rf node_modules package-lock.json
npm install

# Client
cd client
rm -rf node_modules package-lock.json
npm install
```

### Clear Build Files
```bash
cd client
rm -rf dist
npm run build
```

### Clear Logs
```bash
# Find and remove log files
find . -name "*.log" -type f -delete
```

---

## 🗄️ Database Commands

### MongoDB Local

```bash
# Start MongoDB (macOS)
brew services start mongodb-community

# Stop MongoDB (macOS)
brew services stop mongodb-community

# Restart MongoDB (macOS)
brew services restart mongodb-community

# Check MongoDB status (macOS)
brew services list

# Connect with Mongo Shell
mongosh

# Connect to specific database
mongosh paperless
```

### MongoDB Atlas

```bash
# Connect with Mongo Shell (replace with your URI)
mongosh "mongodb+srv://cluster.mongodb.net/paperless" --username <username>

# Import test data
mongoimport --uri="mongodb+srv://..." --collection=forms --file=forms.json
```

---

## 📊 Monitoring Commands

### Check Running Processes
```bash
# Check if Node processes are running
ps aux | grep node

# Check specific ports
lsof -i :5000  # Backend
lsof -i :5173  # Frontend
```

### Kill Processes
```bash
# Kill process on port 5000
kill -9 $(lsof -t -i:5000)

# Kill process on port 5173
kill -9 $(lsof -t -i:5173)

# Kill all Node processes (use with caution!)
killall node
```

### View Logs
```bash
# Real-time server logs
cd server
npm run dev | tee server.log

# Real-time client logs
cd client
npm run dev | tee client.log
```

---

## 🔐 Security Commands

### Generate Secure Secrets
```bash
# Generate random JWT secret (Node.js)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Generate random string (OpenSSL)
openssl rand -hex 64

# Generate UUID
node -e "console.log(require('crypto').randomUUID())"
```

### Hash Password (for testing)
```bash
# Using bcrypt
node -e "const bcrypt=require('bcryptjs'); bcrypt.hash('password', 10).then(console.log)"
```

---

## 🌐 Deployment Commands

### Vercel (Frontend)

```bash
# Install Vercel CLI
npm install -g vercel

# Login
vercel login

# Deploy to preview
cd client
vercel

# Deploy to production
vercel --prod

# Check deployment status
vercel ls

# View logs
vercel logs
```

### Railway (Backend)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
cd server
railway init

# Deploy
railway up

# View logs
railway logs

# Open in browser
railway open
```

### Heroku (Alternative Backend)

```bash
# Install Heroku CLI
npm install -g heroku

# Login
heroku login

# Create app
cd server
heroku create paperless-api

# Add MongoDB
heroku addons:create mongolab

# Set env vars
heroku config:set JWT_SECRET=your_secret

# Deploy
git push heroku main

# View logs
heroku logs --tail
```

---

## 🔧 Maintenance Commands

### Update Dependencies

```bash
# Check outdated packages
cd server
npm outdated

cd client
npm outdated

# Update all packages (use with caution)
npm update

# Update specific package
npm install package-name@latest

# Update to specific version
npm install package-name@1.2.3
```

### Audit Security

```bash
# Check for vulnerabilities
cd server
npm audit

cd client
npm audit

# Fix automatically (if possible)
npm audit fix

# Force fix (may cause breaking changes)
npm audit fix --force
```

---

## 🐛 Debugging Commands

### Node.js Debugging

```bash
# Start with debugger
node --inspect server/src/server.js

# Start with breakpoint
node --inspect-brk server/src/server.js
```

### Environment Variables

```bash
# Print all env vars
cd server
node -e "require('dotenv').config(); console.log(process.env)"

# Print specific var
node -e "require('dotenv').config(); console.log(process.env.MONGO_URI)"
```

### Database Queries

```bash
# Connect to MongoDB and query
mongosh paperless

# In MongoDB shell:
db.users.find()
db.forms.find()
db.questions.find()
db.responses.find()

# Count documents
db.users.countDocuments()

# Find specific document
db.forms.findOne({title: "Test Form"})

# Delete all documents (use carefully!)
db.responses.deleteMany({})
```

---

## 📝 Git Commands

### Basic Workflow

```bash
# Initialize git (if not done)
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit"

# Add remote
git remote add origin <your-repo-url>

# Push
git push -u origin main

# Create branch
git checkout -b feature/new-feature

# Switch branch
git checkout main

# Merge branch
git merge feature/new-feature

# Pull latest
git pull origin main
```

### Ignore .env files

```bash
# Check if .env is ignored
git check-ignore server/.env

# Should return: server/.env
# If not, add to .gitignore
echo "*.env" >> .gitignore
```

---

## 🧪 Testing Commands (if you add tests)

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test auth.test.js

# Run in watch mode
npm test -- --watch
```

---

## 📦 Package Scripts

### Root package.json
```bash
npm run install:server  # Install server deps
npm run install:client  # Install client deps
npm run install:all     # Install both
npm run server          # Start backend
npm run client          # Start frontend
npm run build:client    # Build frontend
```

### Server package.json
```bash
npm start     # Production start
npm run dev   # Development with nodemon
```

### Client package.json
```bash
npm run dev      # Development server
npm run build    # Production build
npm run preview  # Preview build
```

---

## 🎯 Quick Reference

### Most Common Commands

```bash
# Fresh start
cd paperless
./setup.sh              # Install everything

# Start development
cd server && npm run dev    # Terminal 1
cd client && npm run dev    # Terminal 2

# Build for production
cd client && npm run build

# Deploy
cd server && railway up     # Backend
cd client && vercel --prod  # Frontend

# Troubleshooting
npm install                 # Reinstall deps
rm -rf node_modules        # Clean install
lsof -i :5000              # Check port
```

---

## 💡 Pro Tips

```bash
# Run command in background (macOS/Linux)
cd server && npm run dev &

# Pipe output to file
npm run dev > output.log 2>&1

# Set env var for single command
MONGO_URI=mongodb://... npm run dev

# Check Node version
node --version
npm --version

# Clear npm cache
npm cache clean --force

# List globally installed packages
npm list -g --depth=0

# Check package version
npm list package-name
```

---

**Keep this file handy for quick command lookup!** 🚀
