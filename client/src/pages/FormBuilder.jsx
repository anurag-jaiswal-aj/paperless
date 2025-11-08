import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { DragDropContext, Droppable, Draggable } from 'react-beautiful-dnd';
import { setCurrentForm, setQuestions, addQuestion, updateQuestion, removeQuestion, reorderQuestions, setLoading } from '../store/formSlice';
import api from '../utils/api';
import { FiPlus, FiTrash2, FiMove, FiSave, FiZap } from 'react-icons/fi';
import Loader from '../components/Loader';

const QUESTION_TYPES = [
  { value: 'short_text', label: 'Short Text' },
  { value: 'long_text', label: 'Long Text' },
  { value: 'multiple_choice', label: 'Multiple Choice' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'rating', label: 'Rating (1-5)' },
  { value: 'date', label: 'Date' },
  { value: 'file', label: 'File Upload' }
];

const FormBuilder = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { currentForm, questions, loading } = useSelector((state) => state.forms);
  const { theme } = useSelector((state) => state.theme);

  const [formData, setFormData] = useState({ title: '', description: '' });
  const [showAIModal, setShowAIModal] = useState(false);
  const [aiTopic, setAiTopic] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [showImproveModal, setShowImproveModal] = useState(false);
  const [improveQuestion, setImproveQuestion] = useState(null);
  const [improvements, setImprovements] = useState([]);

  useEffect(() => {
    fetchFormData();
  }, [id]);

  const fetchFormData = async () => {
    dispatch(setLoading(true));
    try {
      const response = await api.get(`/api/forms/${id}`);
      if (response.data.success) {
        dispatch(setCurrentForm(response.data.data.form));
        dispatch(setQuestions(response.data.data.questions));
        setFormData({
          title: response.data.data.form.title,
          description: response.data.data.form.description
        });
      }
    } catch (err) {
      alert('Failed to load form');
      navigate('/dashboard');
    }
  };

  const handleFormUpdate = async () => {
    try {
      await api.put(`/api/forms/${id}`, formData);
      alert('Form updated successfully');
    } catch (err) {
      alert('Failed to update form');
    }
  };

  const handleAddQuestion = async (questionData = null) => {
    const newQuestion = questionData || {
      type: 'short_text',
      label: 'Untitled Question',
      required: false,
      options: []
    };

    try {
      const response = await api.post(`/api/forms/${id}/questions`, newQuestion);
      if (response.data.success) {
        dispatch(addQuestion(response.data.data));
      }
    } catch (err) {
      alert('Failed to add question');
    }
  };

  const handleUpdateQuestion = async (questionId, updates) => {
    try {
      const response = await api.put(`/api/forms/${id}/questions/${questionId}`, updates);
      if (response.data.success) {
        dispatch(updateQuestion(response.data.data));
      }
    } catch (err) {
      alert('Failed to update question');
    }
  };

  const handleDeleteQuestion = async (questionId) => {
    if (!confirm('Delete this question?')) return;

    try {
      await api.delete(`/api/forms/${id}/questions/${questionId}`);
      dispatch(removeQuestion(questionId));
    } catch (err) {
      alert('Failed to delete question');
    }
  };

  const handleDragEnd = async (result) => {
    if (!result.destination) return;

    const items = Array.from(questions);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);

    // Update local state immediately
    dispatch(reorderQuestions(items));

    // Update server
    try {
      const questionOrders = items.map((q, index) => ({
        questionId: q._id,
        order: index
      }));
      await api.put(`/api/forms/${id}/questions/reorder`, { questionOrders });
    } catch (err) {
      alert('Failed to reorder questions');
      fetchFormData(); // Revert on error
    }
  };

  const handleAISuggest = async () => {
    if (!aiTopic.trim()) {
      alert('Please enter a topic');
      return;
    }

    setAiLoading(true);
    try {
      const response = await api.post('/api/ai/suggest', { topic: aiTopic });
      if (response.data.success) {
        const suggestions = response.data.data;
        // Add all suggested questions
        for (const suggestion of suggestions) {
          await handleAddQuestion(suggestion);
        }
        setShowAIModal(false);
        setAiTopic('');
      }
    } catch (err) {
      alert(err.response?.data?.message || 'AI suggestion failed. Please check your API key.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleImproveWording = async (question) => {
    setImproveQuestion(question);
    setShowImproveModal(true);
    setAiLoading(true);
    
    try {
      const response = await api.post('/api/ai/improve', { question: question.label });
      if (response.data.success) {
        setImprovements(response.data.data);
      }
    } catch (err) {
      alert('Failed to improve wording');
      setShowImproveModal(false);
    } finally {
      setAiLoading(false);
    }
  };

  const applyImprovement = async (newLabel) => {
    await handleUpdateQuestion(improveQuestion._id, { label: newLabel });
    setShowImproveModal(false);
    setImproveQuestion(null);
  };

  return (
    <div className="min-h-screen">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {loading ? (
          <Loader size="lg" />
        ) : (
          <>
            {/* Form Header */}
            <div className={`border-2 ${theme === 'light' ? 'border-black' : 'border-white'} rounded p-6 mb-6`}>
              <input
                type="text"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                onBlur={handleFormUpdate}
                className="text-3xl font-bold w-full mb-4 bg-transparent border-none focus:outline-none theme-transition"
                placeholder="Form Title"
              />
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                onBlur={handleFormUpdate}
                rows={2}
                className="w-full opacity-70 bg-transparent border-none focus:outline-none theme-transition resize-none"
                placeholder="Form description (optional)"
              />
            </div>

            {/* AI Actions */}
            <div className="flex gap-3 mb-6">
              <button
                onClick={() => setShowAIModal(true)}
                className="btn-primary px-4 py-2 rounded flex items-center gap-2 hover:opacity-80 transition"
              >
                <FiZap /> AI Suggest Questions
              </button>
              <button
                onClick={handleFormUpdate}
                className="btn-secondary px-4 py-2 rounded flex items-center gap-2 hover:opacity-80 transition"
              >
                <FiSave /> Save Changes
              </button>
            </div>

            {/* Questions */}
            <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId="questions">
                {(provided) => (
                  <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-4">
                    {questions.map((question, index) => (
                      <Draggable key={question._id} draggableId={question._id} index={index}>
                        {(provided) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            className={`border-2 ${theme === 'light' ? 'border-black' : 'border-white'} rounded p-6 theme-transition`}
                          >
                            <div className="flex items-start gap-4">
                              <div {...provided.dragHandleProps} className="mt-2 cursor-move opacity-50 hover:opacity-100">
                                <FiMove size={20} />
                              </div>

                              <div className="flex-1">
                                <input
                                  type="text"
                                  value={question.label}
                                  onChange={(e) => handleUpdateQuestion(question._id, { label: e.target.value })}
                                  className="text-lg font-medium w-full mb-3 bg-transparent border-b pb-2 focus:outline-none theme-transition"
                                  placeholder="Question text"
                                />

                                <div className="flex gap-3 flex-wrap items-center">
                                  <select
                                    value={question.type}
                                    onChange={(e) => handleUpdateQuestion(question._id, { type: e.target.value })}
                                    className="px-3 py-1 rounded text-sm focus:outline-none theme-transition"
                                  >
                                    {QUESTION_TYPES.map((type) => (
                                      <option key={type.value} value={type.value}>
                                        {type.label}
                                      </option>
                                    ))}
                                  </select>

                                  <label className="flex items-center gap-2 text-sm">
                                    <input
                                      type="checkbox"
                                      checked={question.required}
                                      onChange={(e) => handleUpdateQuestion(question._id, { required: e.target.checked })}
                                      className="w-4 h-4"
                                    />
                                    Required
                                  </label>

                                  <button
                                    onClick={() => handleImproveWording(question)}
                                    className="text-sm px-3 py-1 btn-secondary rounded hover:opacity-70 transition"
                                  >
                                    <FiZap className="inline mr-1" size={12} /> Improve
                                  </button>

                                  <button
                                    onClick={() => handleDeleteQuestion(question._id)}
                                    className="ml-auto text-red-600 hover:opacity-70 transition"
                                  >
                                    <FiTrash2 />
                                  </button>
                                </div>

                                {/* Options for choice questions */}
                                {['multiple_choice', 'checkbox', 'dropdown'].includes(question.type) && (
                                  <div className="mt-4 space-y-2">
                                    {(question.options || []).map((option, optIndex) => (
                                      <div key={optIndex} className="flex gap-2">
                                        <input
                                          type="text"
                                          value={option}
                                          onChange={(e) => {
                                            const newOptions = [...question.options];
                                            newOptions[optIndex] = e.target.value;
                                            handleUpdateQuestion(question._id, { options: newOptions });
                                          }}
                                          className="flex-1 px-3 py-1 rounded text-sm focus:outline-none theme-transition"
                                          placeholder={`Option ${optIndex + 1}`}
                                        />
                                        <button
                                          onClick={() => {
                                            const newOptions = question.options.filter((_, i) => i !== optIndex);
                                            handleUpdateQuestion(question._id, { options: newOptions });
                                          }}
                                          className="text-red-600 hover:opacity-70"
                                        >
                                          <FiTrash2 size={14} />
                                        </button>
                                      </div>
                                    ))}
                                    <button
                                      onClick={() => {
                                        const newOptions = [...(question.options || []), ''];
                                        handleUpdateQuestion(question._id, { options: newOptions });
                                      }}
                                      className="text-sm opacity-70 hover:opacity-100"
                                    >
                                      + Add option
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>

            {/* Add Question Button */}
            <button
              onClick={() => handleAddQuestion()}
              className="w-full border-2 border-dashed rounded p-6 hover:bg-opacity-10 hover:bg-gray-500 transition mt-4"
            >
              <FiPlus className="inline mr-2" /> Add Question
            </button>

            {/* AI Suggest Modal */}
            {showAIModal && (
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                <div className={`${theme === 'light' ? 'bg-white' : 'bg-black'} border-2 rounded p-8 max-w-md w-full`}>
                  <h2 className="text-2xl font-bold mb-4">AI Suggest Questions</h2>
                  <p className="opacity-70 mb-4">Enter a topic and AI will suggest relevant questions</p>
                  
                  <input
                    type="text"
                    value={aiTopic}
                    onChange={(e) => setAiTopic(e.target.value)}
                    placeholder="e.g., Customer Satisfaction"
                    className="w-full px-4 py-2 rounded mb-4 focus:outline-none theme-transition"
                    disabled={aiLoading}
                  />

                  <div className="flex gap-3">
                    <button
                      onClick={handleAISuggest}
                      disabled={aiLoading}
                      className="flex-1 btn-primary py-2 rounded hover:opacity-80 transition disabled:opacity-50"
                    >
                      {aiLoading ? 'Generating...' : 'Generate Questions'}
                    </button>
                    <button
                      onClick={() => setShowAIModal(false)}
                      disabled={aiLoading}
                      className="flex-1 btn-secondary py-2 rounded hover:opacity-80 transition"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Improve Wording Modal */}
            {showImproveModal && (
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                <div className={`${theme === 'light' ? 'bg-white' : 'bg-black'} border-2 rounded p-8 max-w-lg w-full`}>
                  <h2 className="text-2xl font-bold mb-4">Improved Versions</h2>
                  
                  {aiLoading ? (
                    <Loader />
                  ) : (
                    <div className="space-y-3">
                      {improvements.map((improvement, index) => (
                        <button
                          key={index}
                          onClick={() => applyImprovement(improvement)}
                          className="w-full text-left p-4 border-2 rounded hover:bg-opacity-10 hover:bg-gray-500 transition"
                        >
                          {improvement}
                        </button>
                      ))}
                    </div>
                  )}

                  <button
                    onClick={() => setShowImproveModal(false)}
                    className="w-full mt-4 btn-secondary py-2 rounded hover:opacity-80 transition"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default FormBuilder;
