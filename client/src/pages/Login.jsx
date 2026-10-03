import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { loginStart, loginSuccess, loginFailure } from '../store/authSlice';
import api from '../utils/api';
import { FiAlertCircle } from 'react-icons/fi';

const Login = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { loading, error } = useSelector((state) => state.auth);


  const [formData, setFormData] = useState({
    email: '',
    password: ''
  });

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    dispatch(loginStart());

    try {
      const response = await api.post('/api/auth/login', formData);

      if (response.data.success) {
        dispatch(loginSuccess({
          user: response.data.data.user
        }));
        navigate('/dashboard');
      }
    } catch (err) {
      dispatch(loginFailure(
        err.response?.data?.message || 'Login failed. Please try again.'
      ));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gray-50 dark:bg-[#030712] theme-transition">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-extrabold mb-3 tracking-tight">Welcome Back</h1>
          <p className="opacity-70 text-lg">Sign in to your Paperless account</p>
        </div>

        <div className="card p-8 md:p-10">
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="p-4 rounded-xl bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border border-red-200 dark:border-red-800 flex items-center gap-3">
                <FiAlertCircle className="w-5 h-5 flex-shrink-0" />
                <p className="text-sm">{error}</p>
              </div>
            )}

          <div>
            <label htmlFor="email" className="block mb-2 font-medium">
              Email
            </label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              required
              className="input"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block mb-2 font-medium">
              Password
            </label>
            <input
              type="password"
              id="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              required
              minLength={6}
              className="input"
              placeholder="••••••••"
            />
          </div>

          <div className="flex justify-end mt-2 mb-4">
            <Link to="/forgot-password" className="text-sm font-medium hover:opacity-70 underline">
              Forgot password?
            </Link>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn btn-lg w-full btn-primary mt-2"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
        </div>

        <p className="text-center mt-8 opacity-70">
          Don&apos;t have an account?{' '}
          <Link to="/register" className="font-semibold text-gray-900 dark:text-gray-100 hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
};

export default Login;
