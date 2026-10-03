# 📝 Paperless

**A modern, AI-powered form builder built with the MERN stack**

Paperless is a production-ready Google Forms alternative featuring drag-and-drop form creation, AI-powered question suggestions, real-time analytics, and a beautiful minimal design with dark/light theme support.

---

## ✨ Features

### Core Functionality
- 🔐 **JWT Authentication** - Secure user registration and login
- 📋 **Form Builder** - Intuitive drag-and-drop interface
- 🎨 **8 Question Types** - Short text, long text, multiple choice, checkboxes, dropdown, rating, date, and file upload
- 📊 **Analytics Dashboard** - Beautiful charts and insights with Recharts
- 📤 **Export Data** - Download responses as CSV or JSON
- 🔗 **Public Sharing** - Generate shareable links for form submissions
- 🌓 **Theme Toggle** - Seamless light/dark mode switching

### AI-Powered Features
- 🤖 **AI Question Suggestions** - Generate relevant questions from any topic
- ✍️ **Improve Wording** - Get AI-enhanced question variants
- 📈 **Auto Summary** - Intelligent response analysis and insights

---

## 🛠️ Tech Stack

### Frontend
- **React 18** with Vite
- **Redux Toolkit** for state management
- **React Router DOM** for navigation
- **TailwindCSS** for styling
- **Recharts** for data visualization
- **React Beautiful DnD** for drag-and-drop
- **React Icons** for UI icons
- **Axios** for API calls

### Backend
- **Node.js** + **Express.js**
- **MongoDB** with Mongoose ODM
- **JWT** for authentication
- **bcryptjs** for password hashing
- **OpenAI API** for AI features
- **Helmet** for security
- **Morgan** for logging
- **CORS** enabled

---

## 📁 Project Structure

```
paperless/
├── client/                    # React frontend
│   ├── src/
│   │   ├── components/       # Reusable components
│   │   │   ├── Navbar.jsx
│   │   │   ├── PrivateRoute.jsx
│   │   │   └── Loader.jsx
│   │   ├── pages/            # Page components
│   │   │   ├── Home.jsx
│   │   │   ├── Login.jsx
│   │   │   ├── Register.jsx
│   │   │   ├── Dashboard.jsx
│   │   │   ├── FormBuilder.jsx
│   │   │   ├── PublicForm.jsx
│   │   │   └── Responses.jsx
│   │   ├── store/            # Redux state management
│   │   │   ├── authSlice.js
│   │   │   ├── formSlice.js
│   │   │   ├── themeSlice.js
│   │   │   └── store.js
│   │   ├── utils/
│   │   │   └── api.js        # Axios instance
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── index.css
│   ├── package.json
│   ├── vite.config.js
│   └── tailwind.config.js
│
├── server/                   # Express backend
│   ├── src/
│   │   ├── models/          # Mongoose schemas
│   │   │   ├── user.js
│   │   │   ├── form.js
│   │   │   ├── question.js
│   │   │   └── response.js
│   │   ├── routes/          # API routes
│   │   │   ├── authRoutes.js
│   │   │   ├── formRoutes.js
│   │   │   ├── responseRoutes.js
│   │   │   └── aiRoutes.js
│   │   ├── controllers/     # Business logic
│   │   │   ├── authController.js
│   │   │   ├── formController.js
│   │   │   ├── responseController.js
│   │   │   └── aiController.js
│   │   ├── middleware/
│   │   │   ├── authMiddleware.js
│   │   │   └── errorHandler.js
│   │   ├── services/
│   │   │   └── openaiService.js
│   │   ├── utils/
│   │   │   └── helpers.js
│   │   └── server.js
│   ├── package.json
│   └── .env.example
│
└── README.md
```

---

## 🚀 Local Setup

### Prerequisites
- **Node.js** (v18 or higher)
- **MongoDB** (local or cloud instance)
- **OpenAI API Key** (for AI features)

### 1️⃣ Clone Repository
```bash
git clone <your-repo-url>
cd paperless
```

### 2️⃣ Backend Setup

```bash
# Navigate to server directory
cd server

# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Edit .env with your credentials
nano .env
```

**Required Environment Variables:**
```env
PORT=5000
NODE_ENV=development

# MongoDB Connection (Railway, MongoDB Atlas, or local)
MONGO_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/paperless

# JWT Secrets (generate strong random strings)
JWT_SECRET=your_super_secret_jwt_key_here
JWT_EXPIRE=7d
JWT_REFRESH_SECRET=your_refresh_secret_key_here
JWT_REFRESH_EXPIRE=30d

# OpenAI API Key
OPENAI_API_KEY=sk-your-openai-api-key-here

# Frontend URL for CORS
FRONTEND_URL=http://localhost:5173
```

**Start the backend:**
```bash
npm run dev
```

Server will run on `http://localhost:5000`

### 3️⃣ Frontend Setup

```bash
# Navigate to client directory
cd ../client

# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Edit .env
nano .env
```

**Frontend Environment Variable:**
```env
VITE_BACKEND_URL=http://localhost:5000
```

**Start the frontend:**
```bash
npm run dev
```

Application will open at `http://localhost:5173`

---

## 🗄️ Database Setup

### Option 1: MongoDB Atlas (Free Tier)
1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
2. Create free cluster
3. Create database user
4. Whitelist IP (0.0.0.0/0 for development)
5. Get connection string and add to `MONGO_URI`

### Option 2: Railway MongoDB
1. Create project on [Railway](https://railway.app)
2. Add MongoDB plugin
3. Copy connection string to `MONGO_URI`

### Option 3: Local MongoDB
```bash
# Install MongoDB locally
brew install mongodb-community  # macOS
# or download from mongodb.com

# Start MongoDB
brew services start mongodb-community

# Use in .env
MONGO_URI=mongodb://localhost:27017/paperless
```

---

## 🤖 OpenAI API Setup

1. Go to [OpenAI Platform](https://platform.openai.com)
2. Create account / Sign in
3. Navigate to API Keys
4. Create new secret key
5. Copy to `.env` as `OPENAI_API_KEY`

**Note:** AI features require credits. Start with $5-10 credit for testing.

---

## 📊 API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user (protected)
- `POST /api/auth/refresh` - Refresh access token

### Forms
- `GET /api/forms` - Get all forms (protected)
- `POST /api/forms` - Create form (protected)
- `GET /api/forms/:id` - Get single form
- `PUT /api/forms/:id` - Update form (protected)
- `DELETE /api/forms/:id` - Delete form (protected)

### Questions
- `POST /api/forms/:id/questions` - Add question (protected)
- `PUT /api/forms/:formId/questions/:questionId` - Update question (protected)
- `DELETE /api/forms/:formId/questions/:questionId` - Delete question (protected)
- `PUT /api/forms/:formId/questions/reorder` - Reorder questions (protected)

### Responses
- `POST /api/responses/:formId` - Submit response (public)
- `GET /api/responses/:formId` - Get responses (protected)
- `GET /api/responses/:formId/analytics` - Get analytics (protected)
- `GET /api/responses/:formId/export` - Export responses (protected)
- `DELETE /api/responses/:formId/:responseId` - Delete response (protected)

### AI Features
- `POST /api/ai/suggest` - Suggest questions from topic (protected)
- `POST /api/ai/improve` - Improve question wording (protected)
- `POST /api/ai/summary/:formId` - Generate response summary (protected)

---

## 🌐 Deployment

### Backend - Railway

1. **Create Railway Account**
   - Go to [Railway](https://railway.app)
   - Sign up / Login with GitHub

2. **Deploy Backend**
   ```bash
   cd server
   railway login
   railway init
   railway up
   ```

3. **Add MongoDB**
   - In Railway dashboard, click "New"
   - Select "Database" → "MongoDB"
   - Copy connection string

4. **Set Environment Variables**
   - In Railway dashboard, go to Variables
   - Add all variables from `.env`
   - Update `MONGO_URI` with Railway MongoDB string
   - Update `FRONTEND_URL` with Vercel URL (after frontend deploy)

5. **Get Backend URL**
   - Railway will provide a URL like `https://yourapp.railway.app`

### Frontend - Vercel

1. **Create Vercel Account**
   - Go to [Vercel](https://vercel.com)
   - Sign up / Login with GitHub

2. **Deploy Frontend**
   ```bash
   cd client
   npm run build  # Test build locally

   # Install Vercel CLI
   npm install -g vercel

   # Deploy
   vercel
   ```

3. **Set Environment Variable**
   - In Vercel dashboard, go to Settings → Environment Variables
   - Add: `VITE_BACKEND_URL` = `https://yourapp.railway.app`

4. **Redeploy**
   - Redeploy to apply environment variable
   - Get your production URL

5. **Update Backend CORS**
   - Go back to Railway backend variables
   - Update `FRONTEND_URL` to your Vercel URL
   - Redeploy backend

---

## 🎨 Theme System

The app features a minimal black-and-white theme with toggle support:

- **Light Mode**: White background, black text, black borders
- **Dark Mode**: Black background, white text, white borders

Theme persists in localStorage and applies CSS classes dynamically.

---

## 🔒 Security Features

- Password hashing with bcrypt (10 salt rounds)
- JWT token authentication
- Protected API routes
- Helmet for security headers
- CORS configuration
- Input validation
- XSS protection

---

## 📝 Usage Guide

### Creating a Form
1. Register/Login to your account
2. Click "Create New Form" on dashboard
3. Add title and description
4. Click "AI Suggest Questions" or add manually
5. Drag to reorder questions
6. Set question types and requirements
7. Click "Save Changes"

### Sharing a Form
1. On Dashboard, click "Share" on any form
2. Copy the public link
3. Share with respondents
4. Anyone can submit (no login required)

### Viewing Responses
1. Click "Responses" on any form
2. View analytics charts
3. Generate AI summary
4. Export as CSV or JSON
5. Review individual submissions

### Using AI Features
1. **Suggest Questions**: Enter topic → Get 5-10 relevant questions
2. **Improve Wording**: Select question → Get 3 enhanced versions
3. **Auto Summary**: Click button → Get AI analysis of responses

---

## 🐛 Troubleshooting

### Backend won't start
- Check MongoDB connection string
- Ensure port 5000 is available
- Verify all environment variables are set

### Frontend won't connect to backend
- Check `VITE_BACKEND_URL` in client/.env
- Ensure backend is running
- Check browser console for CORS errors

### AI features not working
- Verify `OPENAI_API_KEY` is correct
- Check OpenAI account has credits
- Review server logs for API errors

### Database connection failed
- Check MongoDB URI format
- Whitelist IP address in MongoDB Atlas
- Verify database user credentials

---

## 🤝 Contributing

This is a demonstration project. Feel free to:
- Fork the repository
- Create feature branches
- Submit pull requests
- Report issues

---

## 📄 License

MIT License - feel free to use this project for learning or commercial purposes.

---

## 👨‍💻 Developer

Built as a complete MERN stack demonstration project showcasing:
- Modern React patterns (hooks, Redux Toolkit)
- RESTful API design
- MongoDB database modeling
- JWT authentication
- OpenAI integration
- Responsive UI/UX
- Production-ready deployment

---

## 🙏 Acknowledgments

- **React** team for the amazing framework
- **MongoDB** for flexible NoSQL database
- **OpenAI** for powerful AI capabilities
- **Tailwind CSS** for utility-first styling
- **Recharts** for beautiful charts
- **Railway** and **Vercel** for easy deployment

---

## 📞 Support

For questions or issues:
- Open a GitHub issue
- Check the troubleshooting section
- Review API documentation above

---

**Built with ❤️ using the MERN Stack**

