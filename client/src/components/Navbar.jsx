import { Link } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { logout } from '../store/authSlice';
import { toggleTheme } from '../store/themeSlice';
import { FiSun, FiMoon, FiLogOut } from 'react-icons/fi';

const Navbar = () => {
  const dispatch = useDispatch();
  const { isAuthenticated, user } = useSelector((state) => state.auth);
  const { theme } = useSelector((state) => state.theme);

  const handleLogout = () => {
    dispatch(logout());
  };

  const handleThemeToggle = () => {
    dispatch(toggleTheme());
  };

  return (
    <nav className={`border-b-2 ${theme === 'light' ? 'border-black' : 'border-white'} py-4 theme-transition`}>
      <div className="container mx-auto px-4 flex justify-between items-center">
        <Link to="/" className="text-2xl font-bold hover:opacity-70 transition">
          Paperless
        </Link>

        <div className="flex items-center gap-4">
          {/* Theme Toggle */}
          <button
            onClick={handleThemeToggle}
            className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition"
            aria-label="Toggle theme"
          >
            {theme === 'light' ? <FiMoon size={20} /> : <FiSun size={20} />}
          </button>

          {isAuthenticated ? (
            <>
              <Link
                to="/dashboard"
                className="hover:opacity-70 transition font-medium"
              >
                Dashboard
              </Link>
              <span className="text-sm opacity-70">{user?.name}</span>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 btn-secondary px-4 py-2 rounded hover:opacity-70 transition"
              >
                <FiLogOut />
                Logout
              </button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="hover:opacity-70 transition font-medium"
              >
                Login
              </Link>
              <Link
                to="/register"
                className="btn-primary px-4 py-2 rounded hover:opacity-70 transition"
              >
                Sign Up
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
