import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useSelector } from 'react-redux';
import Navbar from './components/Navbar';
import PrivateRoute from './components/PrivateRoute';
import Home from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import FormBuilder from './pages/FormBuilder';
import PublicForm from './pages/PublicForm';
import Responses from './pages/Responses';

function App() {
  const { theme } = useSelector((state) => state.theme);

  return (
    <div className={`${theme === 'light' ? 'theme-light' : 'theme-dark'} theme-transition min-h-screen`}>
      <Router>
        <Navbar />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
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
      </Router>
    </div>
  );
}

export default App;
