import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { FiCheck } from 'react-icons/fi';

const Home = () => {
  const { isAuthenticated } = useSelector((state) => state.auth);
  const { theme } = useSelector((state) => state.theme);

  const features = [
    'Drag-and-drop form builder',
    'Multiple question types',
    'AI-powered question suggestions',
    'Automatic response analytics',
    'Export data as CSV or JSON',
    'Beautiful minimal design',
    'Light/Dark theme toggle',
    'Shareable public links'
  ];

  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <div className="container mx-auto px-4 py-20 text-center">
        <h1 className="text-6xl font-bold mb-6">
          Build Forms.<br />Powered by AI.
        </h1>
        <p className="text-xl opacity-70 mb-12 max-w-2xl mx-auto">
          Create beautiful, intelligent forms in minutes. Collect responses, analyze data,
          and get AI-powered insights — all in one place.
        </p>

        {isAuthenticated ? (
          <Link
            to="/dashboard"
            className="btn inline-block btn-primary text-lg"
          >
            Go to Dashboard
          </Link>
        ) : (
          <div className="flex gap-4 justify-center">
            <Link
              to="/register"
              className="btn btn-primary text-lg"
            >
              Get Started Free
            </Link>
            <Link
              to="/login"
              className="btn btn-secondary text-lg"
            >
              Sign In
            </Link>
          </div>
        )}
      </div>

      {/* Features Section */}
      <div className="container mx-auto px-4 py-16">
        <div className={`border-t-2 ${theme === 'light' ? 'border-black' : 'border-white'} pt-16`}>
          <h2 className="text-4xl font-bold text-center mb-12">
            Everything you need to create amazing forms
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 max-w-6xl mx-auto">
            {features.map((feature, index) => (
              <div key={index} className="flex items-start gap-3">
                <FiCheck className="mt-1 flex-shrink-0" size={20} />
                <span>{feature}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CTA Section */}
      <div className="container mx-auto px-4 py-20">
        <div className={`card p-12 text-center`}>
          <h2 className="text-3xl font-bold mb-4">Ready to go paperless?</h2>
          <p className="opacity-70 mb-8 text-lg">
            Join thousands of users building smarter forms
          </p>
          {!isAuthenticated && (
            <Link
              to="/register"
              className="btn inline-block btn-primary text-lg"
            >
              Create Your First Form
            </Link>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className={`border-t-2 ${theme === 'light' ? 'border-black' : 'border-white'} py-8 mt-16`}>
        <div className="container mx-auto px-4 text-center opacity-70">
          <p>&copy; 2025 Paperless. Built with MERN Stack.</p>
        </div>
      </footer>
    </div>
  );
};

export default Home;
