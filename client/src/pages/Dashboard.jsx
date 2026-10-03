import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { setForms, setLoading, setError, addForm, removeForm } from '../store/formSlice';
import api from '../utils/api';
import { FiPlus, FiEdit, FiTrash2, FiBarChart2, FiCopy, FiFileText, FiAlertCircle } from 'react-icons/fi';
import Loader from '../components/Loader';

const Dashboard = () => {
  const dispatch = useDispatch();
  const { forms, loading, error } = useSelector((state) => state.forms);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newFormData, setNewFormData] = useState({
    title: '',
    description: ''
  });

  const fetchForms = useCallback(async () => {
    dispatch(setLoading(true));
    try {
      const response = await api.get('/api/forms');
      if (response.data.success) {
        dispatch(setForms(response.data.data));
      }
    } catch (err) {
      dispatch(setError(err.response?.data?.message || 'Failed to load forms'));
    }
  }, [dispatch]);

  useEffect(() => {
    fetchForms();
  }, [fetchForms]);

  const handleCreateForm = async (e) => {
    e.preventDefault();
    try {
      const response = await api.post('/api/forms', newFormData);
      if (response.data.success) {
        dispatch(addForm(response.data.data));
        setShowCreateModal(false);
        setNewFormData({ title: '', description: '' });
      }
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to create form');
    }
  };

  const handleDeleteForm = async (formId) => {
    if (!confirm('Are you sure you want to delete this form? This action cannot be undone.')) {
      return;
    }

    try {
      const response = await api.delete(`/api/forms/${formId}`);
      if (response.data.success) {
        dispatch(removeForm(formId));
      }
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to delete form');
    }
  };

  const copyShareLink = (formId) => {
    const link = `${window.location.origin}/form/${formId}`;
    navigator.clipboard.writeText(link);
    alert('Share link copied to clipboard!');
  };

  return (
    <div className="min-h-screen">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold mb-2">My Forms</h1>
            <p className="opacity-70">Create and manage your forms</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn btn-primary"
          >
            <FiPlus /> Create New Form
          </button>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border border-red-200 dark:border-red-800 flex items-center gap-3">
            <FiAlertCircle className="w-5 h-5 flex-shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {/* Forms Grid */}
        {loading ? (
          <Loader size="lg" />
        ) : forms.length === 0 ? (
          <div className="text-center py-20 px-4 card flex flex-col items-center justify-center bg-transparent border-dashed">
            <div className="bg-gray-100 dark:bg-gray-800 p-4 rounded-full mb-4">
              <FiFileText className="w-8 h-8 opacity-50" />
            </div>
            <h3 className="text-xl font-bold mb-2">No forms yet</h3>
            <p className="opacity-70 mb-6 max-w-sm mx-auto">Create your first form to start collecting responses and gathering insights.</p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="btn btn-primary"
            >
              <FiPlus /> Create New Form
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {forms.map((form) => (
              <div
                key={form._id}
                className="card flex flex-col"
              >
                <div className="card-header border-b border-gray-100 dark:border-gray-800">
                  <div className="flex justify-between items-start mb-1">
                    <h3 className="text-xl font-bold line-clamp-1" title={form.title}>{form.title}</h3>
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                      form.status === 'published' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                      form.status === 'closed' ? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400' :
                      'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                    }`}>
                      {form.status ? form.status.charAt(0).toUpperCase() + form.status.slice(1) : 'Draft'}
                    </span>
                  </div>
                  <p className="opacity-70 text-sm line-clamp-2 min-h-[2.5rem]">
                    {form.description || 'No description'}
                  </p>
                </div>

                <div className="card-content mt-4 flex-1 flex flex-col justify-between">
                  <div className="text-sm font-medium mb-4 flex items-center gap-2">
                    <div className="bg-primary/10 text-primary px-2 py-1 rounded">
                      {form.responseCount || 0} responses
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-auto pt-4 border-t border-gray-100 dark:border-gray-800">
                    <Link
                      to={`/builder/${form._id}`}
                      className="btn btn-secondary text-sm w-full"
                    >
                      <FiEdit size={14} /> Edit
                    </Link>

                    <Link
                      to={`/responses/${form._id}`}
                      className="btn btn-secondary text-sm w-full"
                    >
                      <FiBarChart2 size={14} /> Results
                    </Link>

                    <button
                      onClick={() => copyShareLink(form._id)}
                      className="btn btn-secondary text-sm w-full"
                    >
                      <FiCopy size={14} /> Share
                    </button>

                    <button
                      onClick={() => handleDeleteForm(form._id)}
                      className="btn btn-secondary text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 w-full"
                    >
                      <FiTrash2 size={14} /> Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Create Form Modal */}
        {showCreateModal && (
          <div className="glass-backdrop">
            <div className="glass-panel">
              <h2 className="text-2xl font-bold mb-6">Create New Form</h2>

              <form onSubmit={handleCreateForm} className="space-y-4">
                <div>
                  <label htmlFor="title" className="block mb-2 font-medium">
                    Form Title *
                  </label>
                  <input
                    type="text"
                    id="title"
                    value={newFormData.title}
                    onChange={(e) => setNewFormData({ ...newFormData, title: e.target.value })}
                    required
                    className="input"
                    placeholder="e.g., Customer Feedback Survey"
                  />
                </div>

                <div>
                  <label htmlFor="description" className="block mb-2 font-medium">
                    Description (optional)
                  </label>
                  <textarea
                    id="description"
                    value={newFormData.description}
                    onChange={(e) => setNewFormData({ ...newFormData, description: e.target.value })}
                    rows={3}
                    className="input"
                    placeholder="Brief description of your form"
                  />
                </div>

                <div className="flex gap-3 pt-4">
                  <button
                    type="submit"
                    className="btn flex-1 btn-primary"
                  >
                    Create Form
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateModal(false);
                      setNewFormData({ title: '', description: '' });
                    }}
                    className="btn flex-1 btn-secondary"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
