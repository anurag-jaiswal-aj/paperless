import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { setForms, setLoading, setError, addForm, removeForm } from '../store/formSlice';
import api from '../utils/api';
import { FiPlus, FiEdit, FiTrash2, FiBarChart2, FiCopy } from 'react-icons/fi';
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
          <div className="mb-6 p-4 border-2 border-red-500 rounded bg-red-50 text-red-700">
            {error}
          </div>
        )}

        {/* Forms Grid */}
        {loading ? (
          <Loader size="lg" />
        ) : forms.length === 0 ? (
          <div className="text-center py-16 opacity-70">
            <p className="text-xl mb-4">No forms yet</p>
            <p>Create your first form to get started</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {forms.map((form) => (
              <div
                key={form._id}
                className={`card p-6 hover:shadow-lg transition theme-transition`}
              >
                <h3 className="text-xl font-bold mb-2">{form.title}</h3>
                <p className="opacity-70 mb-4 line-clamp-2">
                  {form.description || 'No description'}
                </p>

                <div className="text-sm opacity-70 mb-4">
                  {form.responseCount || 0} responses
                </div>

                <div className="flex gap-2 flex-wrap">
                  <Link
                    to={`/builder/${form._id}`}
                    className="btn btn-secondary text-sm"
                  >
                    <FiEdit size={14} /> Edit
                  </Link>

                  <Link
                    to={`/responses/${form._id}`}
                    className="btn btn-secondary text-sm"
                  >
                    <FiBarChart2 size={14} /> Responses
                  </Link>

                  <button
                    onClick={() => copyShareLink(form._id)}
                    className="btn btn-secondary text-sm"
                  >
                    <FiCopy size={14} /> Share
                  </button>

                  <button
                    onClick={() => handleDeleteForm(form._id)}
                    className="btn btn-secondary text-sm text-red-600"
                  >
                    <FiTrash2 size={14} /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Create Form Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className={`card p-8 max-w-md w-full theme-transition`}>
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
