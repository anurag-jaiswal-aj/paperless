import React, { Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useSelector } from 'react-redux';
import Navbar from './components/Navbar';
import PrivateRoute from './components/PrivateRoute';

// Lazy loaded pages
const Home = React.lazy(() => import('./pages/Home'));
const Login = React.lazy(() => import('./pages/Login'));
const Register = React.lazy(() => import('./pages/Register'));
const ForgotPassword = React.lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = React.lazy(() => import('./pages/ResetPassword'));
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const FormBuilder = React.lazy(() => import('./pages/FormBuilder'));
const PublicForm = React.lazy(() => import('./pages/PublicForm'));
const Responses = React.lazy(() => import('./pages/Responses'));

// Simple loading fallback
const SuspenseFallback = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="opacity-70">Loading...</div>
  </div>
);

function App() {
  const { theme } = useSelector((state) => state.theme);

  return (
    <div className={`${theme === 'light' ? 'theme-light' : 'theme-dark'} theme-transition min-h-screen`}>
      <Router>
        <Navbar />
        <Suspense fallback={<SuspenseFallback />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password/:token" element={<ResetPassword />} />
            <Route path="/form/:id" element={<PublicForm />} />

            <Route
              path="/dashboard"
              element={
                <PrivateRoute>
                  <Dashboard />
                </PrivateRoute>
              }
            />
            <Route
              path="/builder/:id"
              element={
                <PrivateRoute>
                  <FormBuilder />
                </PrivateRoute>
              }
            />
            <Route
              path="/responses/:id"
              element={
                <PrivateRoute>
                  <Responses />
                </PrivateRoute>
              }
            />
          </Routes>
        </Suspense>
      </Router>
    </div>
  );
}

export default App;
