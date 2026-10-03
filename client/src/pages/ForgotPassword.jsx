import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../utils/api';
import { FiAlertCircle, FiCheckCircle } from 'react-icons/fi';

const ForgotPassword = () => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setMessage('');

    try {
      const response = await api.post('/api/auth/forgotpassword', { email });
      if (response.data.success) {
        setMessage(response.data.message);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gray-50 dark:bg-[#030712] theme-transition">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-extrabold mb-3 tracking-tight">Reset Password</h1>
          <p className="opacity-70 text-lg">Enter your email to receive a reset link</p>
        </div>

        <div className="card p-8 md:p-10">
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="p-4 rounded-xl bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border border-red-200 dark:border-red-800 flex items-center gap-3">
                <FiAlertCircle className="w-5 h-5 flex-shrink-0" />
                <p className="text-sm">{error}</p>
              </div>
            )}
            {message && (
              <div className="p-4 rounded-xl bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400 border border-green-200 dark:border-green-800 flex items-center gap-3">
                <FiCheckCircle className="w-5 h-5 flex-shrink-0" />
                <p className="text-sm">{message}</p>
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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="input"
              placeholder="you@example.com"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn btn-lg w-full btn-primary mt-2"
          >
            {loading ? 'Sending...' : 'Send Reset Link'}
          </button>
        </form>
        </div>

        <p className="text-center mt-8 opacity-70">
          Remember your password?{' '}
          <Link to="/login" className="font-semibold text-gray-900 dark:text-gray-100 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
};

export default ForgotPassword;
