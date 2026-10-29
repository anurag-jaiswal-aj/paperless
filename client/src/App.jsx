import React, { Suspense, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { logout as logoutAction, loginSuccess } from './store/authSlice';
import { onAuthSessionChange } from './utils/api';
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

import Loader from './components/Loader';

// Simple loading fallback
const SuspenseFallback = () => (
  <div className="flex-1 flex flex-col items-center justify-center theme-transition">
    <Loader size="lg" />
  </div>
);

const ScrollToTop = () => {
  const { pathname, search } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname, search]);

  return null;
};

function App() {
  const dispatch = useDispatch();
  const { theme } = useSelector((state) => state.theme);

  useEffect(() => {
    const unsubscribe = onAuthSessionChange?.((event) => {
      if (event.type === 'LOGOUT') {
        dispatch(logoutAction());
      } else if (event.type === 'LOGIN' && event.user) {
        dispatch(loginSuccess({ user: event.user }));
      }
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [dispatch]);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  return (
    <div className="theme-transition min-h-screen flex flex-col bg-surface-app text-text-primary">
      <Router>
        <ScrollToTop />
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
