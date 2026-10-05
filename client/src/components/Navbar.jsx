import { Link, useLocation } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { logout } from '../store/authSlice';
import { toggleTheme } from '../store/themeSlice';
import { FiSun, FiMoon, FiLogOut } from 'react-icons/fi';
import { MdArrowForward } from 'react-icons/md';

const Navbar = () => {
  const dispatch = useDispatch();
  const location = useLocation();
  const { isAuthenticated, user } = useSelector((state) => state.auth);
  const { theme } = useSelector((state) => state.theme);

  const handleLogout = () => {
    dispatch(logout());
  };

  const handleThemeToggle = () => {
    dispatch(toggleTheme());
  };

  const isLandingPage = location.pathname === '/';

  if (isLandingPage) {
    return (
      <header className="fixed top-0 left-0 right-0 z-50 bg-[#ffffff]/90 dark:bg-[#0a0a0a]/90 backdrop-blur-md border-b border-stitch-outline-variant font-['Geist',sans-serif] text-[15px] leading-[24px] tracking-[-0.005em] text-stitch-on-surface">
        <div className="h-[64px] max-w-[1200px] mx-auto px-[32px] flex items-center justify-between">
          <div className="flex items-center gap-[40px]">
            <Link className="flex items-center gap-[8px]" data-path="product" to="/">
              <span className="font-['Geist',sans-serif] text-[20px] leading-[28px] tracking-[-0.015em] font-medium text-stitch-primary">Paperless</span>
            </Link>
            <nav className="hidden md:flex items-center gap-[24px]">
              <Link className="transition-colors text-stitch-primary font-medium" to="/#product">Product</Link>
              <Link className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant hover:text-stitch-primary transition-colors" to="/#landing-overview">Workflow</Link>
              <Link className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant hover:text-stitch-primary transition-colors" to="/#intelligence">Intelligence</Link>
              <span className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant">Documentation</span>
            </nav>
          </div>
          <div className="flex items-center gap-[16px]">
            <button
              onClick={handleThemeToggle}
              className="p-2 rounded-full hover:bg-stitch-surface-container transition text-stitch-on-surface-variant"
              aria-label="Toggle theme"
            >
              {theme === 'light' ? <FiMoon size={20} /> : <FiSun size={20} />}
            </button>
            {isAuthenticated ? (
              <>
                <Link to="/dashboard" className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant hover:text-stitch-primary transition-colors">
                  Dashboard
                </Link>
                <button onClick={handleLogout} className="inline-flex items-center gap-[6px] font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant hover:text-stitch-primary transition-colors">
                  <FiLogOut size={16} />
                  <span>Logout</span>
                </button>
                <div className="w-8 h-8 rounded-full bg-stitch-primary flex items-center justify-center">
                  <span className="text-stitch-on-primary font-['Geist',sans-serif] text-[13px] leading-[20px] font-medium">{user?.name?.charAt(0)?.toUpperCase()}</span>
                </div>
              </>
            ) : (
              <>
                <Link className="font-['Geist',sans-serif] text-[13px] leading-[20px] text-stitch-on-surface-variant hover:text-stitch-primary transition-colors px-[4px] py-[4px]" to="/login">Sign in</Link>
                <Link className="inline-flex items-center gap-[4px] bg-stitch-primary text-stitch-on-primary px-[16px] py-[4px] rounded font-['Geist',sans-serif] text-[13px] leading-[20px] font-medium hover:bg-neutral-800 hover:text-white transition-colors" to="/register">
                  <span>Get Started</span>
                  <MdArrowForward className="text-[16px]" />
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
    );
  }

  // Original app navbar for other pages
  return (
    <nav className="bg-surface-navbar border-b-2 border-black dark:border-border-default py-4 theme-transition shrink-0">
      <div className="container mx-auto px-4 flex justify-between items-center">
        <Link to="/" className="text-2xl font-bold hover:opacity-70 transition">
          Paperless
        </Link>

        <div className="flex items-center gap-4">
          <button
            onClick={handleThemeToggle}
            className="p-2 rounded-full hover:bg-surface-hover transition"
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
                className="btn btn-secondary"
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
                className="btn btn-primary"
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
