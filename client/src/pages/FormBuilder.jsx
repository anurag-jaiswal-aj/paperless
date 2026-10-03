import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { DragDropContext, Droppable, Draggable } from 'react-beautiful-dnd';
import { setCurrentForm, setQuestions, addQuestion, updateQuestion, removeQuestion, reorderQuestions, setLoading } from '../store/formSlice';
import api from '../utils/api';
import { FiPlus, FiTrash2, FiMove, FiZap } from 'react-icons/fi';
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
  const { questions, loading } = useSelector((state) => state.forms);
  const { theme } = useSelector((state) => state.theme);

  const [formData, setFormData] = useState({ title: '', description: '', status: 'draft' });
  const [showAIModal, setShowAIModal] = useState(false);
  const [aiTopic, setAiTopic] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [showImproveModal, setShowImproveModal] = useState(false);
  const [improveTarget, setImproveTarget] = useState(null);
  const [improvements, setImprovements] = useState(null);
  const [showConsultantModal, setShowConsultantModal] = useState(false);
  const [consultantData, setConsultantData] = useState(null);
  const [proposedQuestions, setProposedQuestions] = useState([]);

  const fetchFormData = useCallback(async () => {
    dispatch(setLoading(true));
    try {
      const response = await api.get(`/api/forms/${id}`);
      if (response.data.success) {
        dispatch(setCurrentForm(response.data.data.form));
        dispatch(setQuestions(response.data.data.questions));
        setFormData({
          title: response.data.data.form.title,
          description: response.data.data.form.description,
          status: response.data.data.form.status || 'draft'
        });
      }
    } catch (err) {
      alert('Failed to load form');
      navigate('/dashboard');
    }
  }, [dispatch, id, navigate]);

  useEffect(() => {
    // eslint-disable-next-line
    fetchFormData();
  }, [fetchFormData]);

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
    setProposedQuestions([]);
    try {
      const response = await api.post('/api/ai/questions/generate', { topic: aiTopic, formId: id });
      if (response.data.success) {
        setProposedQuestions(response.data.data);
      }
    } catch (err) {
      alert(err.response?.data?.message || 'AI generation failed. Please check your API key.');
    } finally {
      setAiLoading(false);
    }
  };

  const acceptProposedQuestions = async () => {
    setAiLoading(true);
    try {
      for (const suggestion of proposedQuestions) {
        await handleAddQuestion(suggestion);
      }
      setShowAIModal(false);
      setAiTopic('');
      setProposedQuestions([]);
    } catch (err) {
      alert('Failed to accept proposed questions');
    } finally {
      setAiLoading(false);
    }
  };

  const rejectProposedQuestions = () => {
    setProposedQuestions([]);
    setAiTopic('');
    setShowAIModal(false);
  };

  const handleImproveWording = async (type, text, questionId = null) => {
    setImproveTarget({ type, id: questionId, text });
    setShowImproveModal(true);
    setAiLoading(true);
    setImprovements(null);

    try {
      const response = await api.post('/api/ai/writing/improve', {
        text,
        contentType: type
      });
      if (response.data.success) {
        setImprovements(response.data.data);
      }
    } catch (err) {
      alert('Failed to improve writing');
      setShowImproveModal(false);
    } finally {
      setAiLoading(false);
    }
  };

  const applyImprovement = async () => {
    if (!improvements) return;

    const newText = improvements.improvedText;
    if (improveTarget.type === 'question') {
      await handleUpdateQuestion(improveTarget.id, { label: newText });
    } else if (improveTarget.type === 'title') {
      setFormData(prev => ({ ...prev, title: newText }));
      // Save it explicitly
      await api.put(`/api/forms/${id}`, { ...formData, title: newText });
    } else if (improveTarget.type === 'description') {
      setFormData(prev => ({ ...prev, description: newText }));
      await api.put(`/api/forms/${id}`, { ...formData, description: newText });
    }

    setShowImproveModal(false);
    setImproveTarget(null);
    setImprovements(null);
  };

  const handleConsultant = async () => {
    setShowConsultantModal(true);
    setAiLoading(true);
    try {
      const response = await api.post(`/api/ai/consultant/${id}`);
      if (response.data.success) {
        setConsultantData(response.data.data);
      }
    } catch (err) {
      console.error(err);
      alert(err.response?.data?.message || 'Failed to run consultant');
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="min-h-screen">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {loading ? (
          <Loader size="lg" />
        ) : (
          <>
            {/* Form Header */}
            <div className="card p-6 mb-6">
              <div className="flex gap-2 items-start w-full mb-4">
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  onBlur={handleFormUpdate}
                  className="text-3xl font-bold w-full bg-transparent border-none focus:outline-none theme-transition flex-1"
                  placeholder="Form Title"
                />
                <button
                  onClick={() => handleImproveWording('title', formData.title)}
                  className="text-sm opacity-50 hover:opacity-100 flex items-center shrink-0 mt-2"
                  title="Improve title with AI"
                >
                  <FiZap className="inline mr-1" size={14} /> Improve
                </button>
              </div>
              <div className="flex gap-2 items-start w-full">
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  onBlur={handleFormUpdate}
                  rows={2}
                  className="w-full opacity-70 bg-transparent border-none focus:outline-none theme-transition resize-none flex-1"
                  placeholder="Form description (optional)"
                />
                <button
                  onClick={() => handleImproveWording('description', formData.description)}
                  className="text-sm opacity-50 hover:opacity-100 flex items-center shrink-0"
                  title="Improve description with AI"
                >
                  <FiZap className="inline mr-1" size={14} /> Improve
                </button>
              </div>
            </div>

            {/* AI Actions */}
            <div className="flex gap-3 mb-6 items-center flex-wrap">
              <button
                onClick={() => setShowAIModal(true)}
                className="btn btn-primary px-4 py-2 rounded flex items-center gap-2"
              >
                <FiZap /> AI Suggest Questions
              </button>

              <button
                onClick={handleConsultant}
                className="btn btn-secondary px-4 py-2 rounded flex items-center gap-2"
              >
                Form Consultant
              </button>

              <div className="ml-auto flex items-center gap-2">
                <span className="text-sm opacity-70">Status:</span>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="input py-1 px-2 text-sm max-w-[120px]"
                >
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                  <option value="closed">Closed</option>
                </select>
              </div>
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
                            className={`card p-6 theme-transition`}
                          >
                            <div className="flex items-start gap-4">
                              <div {...provided.dragHandleProps} className="mt-2 cursor-move opacity-50 hover:opacity-100">
                                <FiMove size={20} />
                              </div>

                              <div className="flex-1">
                                <div className="flex gap-2 items-start w-full mb-3 border-b pb-2">
                                  <input
                                    type="text"
                                    value={question.label}
                                    onChange={(e) => handleUpdateQuestion(question._id, { label: e.target.value })}
                                    className="text-lg font-medium w-full bg-transparent focus:outline-none theme-transition flex-1"
                                    placeholder="Question text"
                                  />
                                  <button
                                    onClick={() => handleImproveWording('question', question.label, question._id)}
                                    className="text-sm opacity-50 hover:opacity-100 flex items-center shrink-0 mt-1"
                                    title="Improve question wording with AI"
                                  >
                                    <FiZap className="inline mr-1" size={14} /> Improve
                                  </button>
                                </div>

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
                                    onClick={() => handleDeleteQuestion(question._id)}
                                    className="ml-auto text-red-600 hover:opacity-70 transition"
                                  >
                                    <FiTrash2 />
                                  </button>
                                </div>

                                {/* Visibility Rule Section */}
                                <div className="mt-3 text-sm bg-gray-500 bg-opacity-10 p-3 rounded">
                                  <div className="font-semibold mb-2 opacity-70">Conditional Visibility</div>
                                  <div className="flex gap-2 flex-wrap">
                                    <select
                                      value={question.visibilityRule?.targetQuestionId || ''}
                                      onChange={(e) => {
                                        const newRule = e.target.value
                                          ? { targetQuestionId: e.target.value, operator: 'equals', value: '' }
                                          : null;
                                        handleUpdateQuestion(question._id, { visibilityRule: newRule });
                                      }}
                                      className="input px-2 py-1 text-black h-8 text-sm"
                                    >
                                      <option value="">Always Visible</option>
                                      {questions
                                        .filter(q => q._id !== question._id && q.order < question.order)
                                        .map(q => (
                                          <option key={q._id} value={q._id}>When &apos;{q.label}&apos;...</option>
                                        ))}
                                    </select>

                                    {question.visibilityRule && (
                                      <>
                                        <select
                                          value={question.visibilityRule.operator || 'equals'}
                                          onChange={(e) => handleUpdateQuestion(question._id, {
                                            visibilityRule: { ...question.visibilityRule, operator: e.target.value }
                                          })}
                                          className="input px-2 py-1 text-black h-8 text-sm"
                                        >
                                          <option value="equals">Equals</option>
                                          <option value="not_equals">Does not equal</option>
                                          <option value="contains">Contains</option>
                                        </select>
                                        <input
                                          type="text"
                                          placeholder="Value"
                                          value={question.visibilityRule.value || ''}
                                          onChange={(e) => handleUpdateQuestion(question._id, {
                                            visibilityRule: { ...question.visibilityRule, value: e.target.value }
                                          })}
                                          className="input px-2 py-1 text-black w-24 h-8 text-sm"
                                        />
                                      </>
                                    )}
                                  </div>
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
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto">
                <div className={`card p-8 max-w-2xl w-full my-8`}>
                  <h2 className="text-2xl font-bold mb-4">AI Question Generation</h2>
                  <p className="opacity-70 mb-4">Enter a topic and AI will suggest relevant questions for your form.</p>

                  {!proposedQuestions.length ? (
                    <>
                      <input
                        type="text"
                        value={aiTopic}
                        onChange={(e) => setAiTopic(e.target.value)}
                        placeholder="e.g., Customer Satisfaction"
                        className="input mb-4"
                        disabled={aiLoading}
                      />

                      <div className="flex gap-3">
                        <button
                          onClick={handleAISuggest}
                          disabled={aiLoading}
                          className="btn flex-1 btn-primary"
                        >
                          <FiZap className="inline mr-2" />
                          {aiLoading ? 'Generating...' : 'Generate Questions'}
                        </button>
                        <button
                          onClick={() => setShowAIModal(false)}
                          disabled={aiLoading}
                          className="btn flex-1 btn-secondary"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="mb-4">
                        <h3 className="font-bold mb-2 text-lg">Proposed Questions</h3>
                        <div className="space-y-2 max-h-60 overflow-y-auto pr-2">
                          {proposedQuestions.map((q, idx) => (
                            <div key={idx} className="p-3 border border-gray-500 border-opacity-30 rounded">
                              <p className="font-semibold">{q.label}</p>
                              {q.description && <p className="text-sm opacity-70">{q.description}</p>}
                              <p className="text-xs opacity-50 mt-1 uppercase">{q.type.replace('_', ' ')}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="flex gap-3 mt-4">
                        <button
                          onClick={acceptProposedQuestions}
                          disabled={aiLoading}
                          className="btn flex-1 btn-primary"
                        >
                          {aiLoading ? 'Saving...' : 'Accept All'}
                        </button>
                        <button
                          onClick={rejectProposedQuestions}
                          disabled={aiLoading}
                          className="btn flex-1 btn-secondary"
                        >
                          Reject
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Improve Wording Modal */}
            {showImproveModal && (
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                <div className={`card p-8 max-w-lg w-full`}>
                  <h2 className="text-2xl font-bold mb-4">AI Writing Improvement</h2>

                  {aiLoading ? (
                    <div className="py-8">
                      <Loader />
                    </div>
                  ) : improvements ? (
                    <div className="space-y-4">
                      <div className="p-4 border-2 border-primary border-opacity-50 rounded bg-primary bg-opacity-5">
                        <p className="font-medium text-lg mb-2">{improvements.improvedText}</p>
                        {improvements.changesSummary && (
                          <p className="text-sm opacity-70">Changes: {improvements.changesSummary}</p>
                        )}
                      </div>

                      <div className="flex gap-3 mt-6">
                        <button
                          onClick={applyImprovement}
                          className="btn flex-1 btn-primary"
                        >
                          Apply
                        </button>
                        <button
                          onClick={() => {
                            setShowImproveModal(false);
                            setImproveTarget(null);
                            setImprovements(null);
                          }}
                          className="btn flex-1 btn-secondary"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {/* Consultant Modal */}
            {showConsultantModal && (
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto">
                <div
                  className={`${theme === 'light' ? 'bg-white' : 'bg-black'} border-2 rounded p-8 max-w-2xl w-full my-8`}
                >
                  <h2 className="text-2xl font-bold mb-4">Form Consultant</h2>

                  {aiLoading ? (
                    <div className="py-8"><Loader /></div>
                  ) : consultantData ? (
                    <div className="space-y-6">
                      <div className="p-4 border rounded bg-gray-500 bg-opacity-10">
                        <h3 className="font-bold mb-2">Overall Assessment</h3>
                        <p>{consultantData.overallAssessment}</p>
                      </div>

                      {consultantData.recommendations?.length > 0 ? (
                        <div className="space-y-4">
                          <h3 className="font-bold text-lg">Recommendations</h3>
                          {consultantData.recommendations.map((rec, i) => (
                            <div key={i} className="p-4 border rounded relative">
                              <span className={`absolute top-2 right-2 text-xs px-2 py-1 rounded capitalize ${
                                rec.severity === 'warning' ? 'bg-red-500 text-white' :
                                rec.severity === 'suggestion' ? 'bg-yellow-500 text-black' :
                                'bg-blue-500 text-white'
                              }`}>
                                {rec.severity}
                              </span>
                              <div className="font-bold mb-1 opacity-70 capitalize">{rec.category} Issue</div>
                              <p className="mb-2">{rec.issue}</p>
                              <div className="text-sm font-semibold text-green-500 mb-1">Suggestion:</div>
                              <p className="text-sm">{rec.suggestion}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p>No major issues found! Looks good.</p>
                      )}
                    </div>
                  ) : null}

                  <button
                    onClick={() => setShowConsultantModal(false)}
                    className="w-full mt-6 btn btn-secondary py-2 rounded hover:opacity-80 transition"
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
