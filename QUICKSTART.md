# Paperless - Quick Start Guide

## 🚀 Get Running in 5 Minutes

### 1. Install Dependencies

```bash
# Install backend dependencies
cd server
npm install

# Install frontend dependencies  
cd ../client
npm install
```

### 2. Setup Environment Variables

Backend `.env` is already created with development defaults. You only need to add:
- Your MongoDB URI (if not using local MongoDB)
- Your OpenAI API key (for AI features)

```bash
cd server
nano .env  # or use any text editor
```

### 3. Start MongoDB (if using local)

```bash
# macOS
brew services start mongodb-community

# Windows
net start MongoDB

# Linux
sudo systemctl start mongod
```

### 4. Start the Application

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

### 5. Open Browser

Navigate to: `http://localhost:5173`

---

## 🎯 First Steps

1. **Register** a new account
2. Click **"Create New Form"**
3. Try **"AI Suggest Questions"** (requires OpenAI key)
4. Add questions manually
5. Drag to reorder
6. Click **"Share"** to get public link
7. Submit a test response
8. View **"Responses"** for analytics

---

## ⚙️ Quick Configuration

### Without MongoDB (File-based for testing)
The app requires MongoDB. For quick testing:
1. Use MongoDB Atlas free tier (5 minutes setup)
2. Or install MongoDB locally (see main README)

### Without OpenAI (Basic features only)
The app works without OpenAI! Just skip:
- AI Suggest Questions
- Improve Wording  
- Auto Summary

All other features work perfectly.

---

## 📦 Production Build

```bash
# Backend
cd server
npm start

# Frontend
cd client
npm run build
npm run preview
```

---

## 🐛 Common Issues

**Port already in use:**
```bash
# Change port in server/.env
PORT=5001
```

**MongoDB connection failed:**
```bash
# Use MongoDB Atlas instead
MONGO_URI=mongodb+srv://...
```

**Cannot find module:**
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

---

**Need help?** Check the main README.md for detailed documentation.
