# 📋 Paperless - Complete Setup Checklist

Use this checklist to ensure your Paperless installation is complete and running correctly.

---

## ✅ Pre-Installation Checklist

- [ ] Node.js v18+ installed (`node --version`)
- [ ] npm installed (`npm --version`)
- [ ] MongoDB access (local or cloud)
- [ ] OpenAI API key (optional, for AI features)
- [ ] Git installed (for version control)
- [ ] Code editor installed (VS Code recommended)

---

## ✅ Installation Checklist

### Automated Setup (Recommended)
- [ ] Run `./setup.sh` (macOS/Linux) or `setup.bat` (Windows)
- [ ] Wait for dependencies to install

### Manual Setup (Alternative)
- [ ] Run `cd server && npm install`
- [ ] Run `cd ../client && npm install`

---

## ✅ Configuration Checklist

### Backend Configuration
- [ ] Open `server/.env` file
- [ ] Update `MONGO_URI` with your MongoDB connection string
- [ ] Add `OPENAI_API_KEY` (optional, for AI features)
- [ ] Update `JWT_SECRET` with a strong random string (production)
- [ ] Update `JWT_REFRESH_SECRET` with another random string (production)
- [ ] Verify `PORT=5000` (or change if needed)
- [ ] Verify `FRONTEND_URL=http://localhost:5173`

### Frontend Configuration
- [ ] Open `client/.env` file
- [ ] Verify `VITE_BACKEND_URL=http://localhost:5000`

---

## ✅ Database Setup Checklist

Choose one option:

### Option A: Local MongoDB
- [ ] Install MongoDB Community Edition
- [ ] Start MongoDB service
- [ ] Use `MONGO_URI=mongodb://localhost:27017/paperless`

### Option B: MongoDB Atlas (Recommended)
- [ ] Create free account at mongodb.com/cloud/atlas
- [ ] Create new cluster (free tier)
- [ ] Create database user
- [ ] Whitelist IP (0.0.0.0/0 for development)
- [ ] Copy connection string to `MONGO_URI`
- [ ] Replace `<password>` with your database password
- [ ] Replace `<dbname>` with `paperless`

### Option C: Railway MongoDB
- [ ] Create Railway account
- [ ] Create new project
- [ ] Add MongoDB plugin
- [ ] Copy connection string to `MONGO_URI`

---

## ✅ OpenAI Setup Checklist (Optional)

For AI features (suggest questions, improve wording, auto summary):

- [ ] Visit platform.openai.com
- [ ] Create account or sign in
- [ ] Add payment method (required for API access)
- [ ] Add $5-10 credit for testing
- [ ] Navigate to API Keys section
- [ ] Create new secret key
- [ ] Copy key to `server/.env` as `OPENAI_API_KEY`
- [ ] Save the key securely (shown only once)

**Skip this section if you don't need AI features** - the app works perfectly without them!

---

## ✅ Running the Application

### Terminal 1 - Backend
- [ ] Open terminal
- [ ] Navigate to project: `cd /path/to/paperless`
- [ ] Start server: `cd server && npm run dev`
- [ ] Wait for "✅ MongoDB Connected"
- [ ] Wait for "🚀 Server running on port 5000"
- [ ] Leave terminal running

### Terminal 2 - Frontend
- [ ] Open new terminal
- [ ] Navigate to project: `cd /path/to/paperless`
- [ ] Start client: `cd client && npm run dev`
- [ ] Wait for "ready in X ms"
- [ ] Browser should auto-open to http://localhost:5173
- [ ] Leave terminal running

---

## ✅ First Run Checklist

### Registration
- [ ] Click "Sign Up" or "Get Started Free"
- [ ] Fill in name, email, password
- [ ] Click "Sign Up"
- [ ] Verify redirect to dashboard

### Create First Form
- [ ] Click "Create New Form"
- [ ] Enter form title (e.g., "Test Survey")
- [ ] Enter description (optional)
- [ ] Click "Create Form"
- [ ] Verify redirect to form builder

### Add Questions
- [ ] Click "Add Question"
- [ ] Change question type (dropdown)
- [ ] Edit question text
- [ ] Toggle "Required" checkbox
- [ ] Add more questions
- [ ] Try drag-and-drop to reorder
- [ ] For multiple choice: add options
- [ ] Click "Save Changes"

### Test AI Features (if configured)
- [ ] Click "AI Suggest Questions"
- [ ] Enter a topic (e.g., "Customer Satisfaction")
- [ ] Click "Generate Questions"
- [ ] Wait for AI-generated questions
- [ ] Select a question
- [ ] Click "Improve" button
- [ ] Choose improved version

### Share Form
- [ ] Go back to Dashboard
- [ ] Click "Share" on your form
- [ ] Copy the public link
- [ ] Open in new browser tab (incognito)
- [ ] Verify form loads
- [ ] Fill out and submit

### View Responses
- [ ] Go back to Dashboard (original window)
- [ ] Click "Responses" on your form
- [ ] Verify response appears
- [ ] Check analytics charts
- [ ] Click "Export CSV" to download
- [ ] Click "Generate Summary" (if OpenAI configured)

### Test Theme Toggle
- [ ] Click moon/sun icon in navbar
- [ ] Verify theme switches
- [ ] Refresh page
- [ ] Verify theme persists

---

## ✅ Verification Checklist

### Backend Health
- [ ] Visit http://localhost:5000/health
- [ ] See `{"success": true, "message": "Server is running"}`

### Frontend Access
- [ ] Visit http://localhost:5173
- [ ] See Paperless landing page
- [ ] No console errors in browser DevTools

### Database Connection
- [ ] Check server terminal
- [ ] See "✅ MongoDB Connected: [host]"
- [ ] No connection errors

### API Communication
- [ ] Open browser DevTools → Network tab
- [ ] Login or register
- [ ] See successful API calls to http://localhost:5000
- [ ] Status 200 or 201 responses

---

## ✅ Troubleshooting Checklist

If something's not working:

### Backend Issues
- [ ] Check `server/.env` file exists
- [ ] Verify MongoDB connection string is correct
- [ ] Check port 5000 is available: `lsof -i :5000`
- [ ] Review server terminal for error messages
- [ ] Try: `cd server && npm install` again

### Frontend Issues
- [ ] Check `client/.env` file exists
- [ ] Verify VITE_BACKEND_URL points to http://localhost:5000
- [ ] Check browser console for errors
- [ ] Review client terminal for error messages
- [ ] Try: `cd client && npm install` again

### Database Issues
- [ ] Verify MongoDB is running (if local)
- [ ] Test connection string with MongoDB Compass
- [ ] Check firewall settings
- [ ] Verify IP whitelist (MongoDB Atlas)
- [ ] Check database user credentials

### CORS Issues
- [ ] Verify `FRONTEND_URL` in server/.env matches client URL
- [ ] Check browser console for CORS errors
- [ ] Restart both servers

### AI Features Not Working
- [ ] Verify `OPENAI_API_KEY` is set in server/.env
- [ ] Check OpenAI account has credits
- [ ] Review server logs for API errors
- [ ] Visit platform.openai.com to check usage

---

## ✅ Production Deployment Checklist

### Before Deployment
- [ ] Test thoroughly locally
- [ ] Change JWT secrets to strong random strings
- [ ] Set `NODE_ENV=production` in server env
- [ ] Remove console.logs (optional)
- [ ] Review security settings

### Railway (Backend)
- [ ] Create Railway account
- [ ] Install Railway CLI: `npm i -g @railway/cli`
- [ ] Run `railway login`
- [ ] Run `cd server && railway init`
- [ ] Run `railway up`
- [ ] Add MongoDB plugin in Railway dashboard
- [ ] Set all environment variables
- [ ] Copy Railway URL

### Vercel (Frontend)
- [ ] Create Vercel account
- [ ] Install Vercel CLI: `npm i -g vercel`
- [ ] Run `cd client && vercel`
- [ ] Set `VITE_BACKEND_URL` to Railway URL
- [ ] Deploy: `vercel --prod`

### Post-Deployment
- [ ] Update `FRONTEND_URL` in Railway to Vercel URL
- [ ] Test registration on live site
- [ ] Test form creation
- [ ] Test form submission (public link)
- [ ] Test all features
- [ ] Monitor logs for errors

---

## ✅ Optional Enhancements

Consider adding:
- [ ] Email notifications for responses
- [ ] Form templates
- [ ] Team collaboration
- [ ] Custom branding
- [ ] Advanced analytics
- [ ] Conditional logic
- [ ] File upload to cloud storage
- [ ] Payment integration
- [ ] Multi-language support
- [ ] Form scheduling (start/end dates)

---

## 🎉 Completion

When all checkboxes are marked:
- ✅ **Installation Complete**
- ✅ **Configuration Complete**
- ✅ **Database Connected**
- ✅ **Application Running**
- ✅ **Testing Successful**

**Congratulations! Your Paperless form builder is ready to use!** 🚀

---

## 📞 Need Help?

If you're stuck:
1. Review the error message carefully
2. Check the TROUBLESHOOTING section in README.md
3. Search the error on Stack Overflow
4. Review server/client terminal logs
5. Check browser DevTools console

---

**Last Updated**: 2025-01-08
**Version**: 1.0.0
