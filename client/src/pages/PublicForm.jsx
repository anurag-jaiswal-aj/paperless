import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useSelector } from 'react-redux';
import api from '../utils/api';
import Loader from '../components/Loader';
import { FiCheckCircle } from 'react-icons/fi';

const PublicForm = () => {
  const { id } = useParams();
  const { theme } = useSelector((state) => state.theme);
  const [form, setForm] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchForm();
  }, [id]);

  const fetchForm = async () => {
    try {
      const response = await api.get(`/api/forms/${id}`);
      if (response.data.success) {
        setForm(response.data.data.form);
        setQuestions(response.data.data.questions);
      }
    } catch (err) {
      setError('Form not found or not available');
    } finally {
      setLoading(false);
    }
  };

  const handleAnswerChange = (questionId, value) => {
    setAnswers({
      ...answers,
      [questionId]: value
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // Validate required questions
    const requiredQuestions = questions.filter(q => q.required);
    for (const q of requiredQuestions) {
      if (!answers[q._id] || answers[q._id] === '') {
        setError(`Please answer: ${q.label}`);
        return;
      }
    }

    setSubmitting(true);

    try {
      const formattedAnswers = Object.entries(answers).map(([questionId, value]) => ({
        questionId,
        value
      }));

      const response = await api.post(`/api/responses/${id}`, { answers: formattedAnswers });
      
      if (response.data.success) {
        setSubmitted(true);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to submit response');
    } finally {
      setSubmitting(false);
    }
  };

  const renderQuestion = (question) => {
    const questionId = question._id;

    switch (question.type) {
      case 'short_text':
        return (
          <input
            type="text"
            value={answers[questionId] || ''}
            onChange={(e) => handleAnswerChange(questionId, e.target.value)}
            required={question.required}
            className="w-full px-4 py-2 rounded border-2 focus:outline-none focus:ring-2 theme-transition"
            placeholder="Your answer"
          />
        );

      case 'long_text':
        return (
          <textarea
            value={answers[questionId] || ''}
            onChange={(e) => handleAnswerChange(questionId, e.target.value)}
            required={question.required}
            rows={4}
            className="w-full px-4 py-2 rounded border-2 focus:outline-none focus:ring-2 theme-transition"
            placeholder="Your answer"
          />
        );

      case 'multiple_choice':
        return (
          <div className="space-y-2">
            {question.options.map((option, index) => (
              <label key={index} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name={questionId}
                  value={option}
                  checked={answers[questionId] === option}
                  onChange={(e) => handleAnswerChange(questionId, e.target.value)}
                  required={question.required}
                  className="w-4 h-4"
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        );

      case 'checkbox':
        return (
          <div className="space-y-2">
            {question.options.map((option, index) => (
              <label key={index} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  value={option}
                  checked={(answers[questionId] || []).includes(option)}
                  onChange={(e) => {
                    const current = answers[questionId] || [];
                    const newValue = e.target.checked
                      ? [...current, option]
                      : current.filter(v => v !== option);
                    handleAnswerChange(questionId, newValue);
                  }}
                  className="w-4 h-4"
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        );

      case 'dropdown':
        return (
          <select
            value={answers[questionId] || ''}
            onChange={(e) => handleAnswerChange(questionId, e.target.value)}
            required={question.required}
            className="w-full px-4 py-2 rounded border-2 focus:outline-none focus:ring-2 theme-transition"
          >
            <option value="">Select an option</option>
            {question.options.map((option, index) => (
              <option key={index} value={option}>
                {option}
              </option>
            ))}
          </select>
        );

      case 'rating':
        return (
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((rating) => (
              <button
                key={rating}
                type="button"
                onClick={() => handleAnswerChange(questionId, rating)}
                className={`w-12 h-12 rounded border-2 font-bold transition ${
                  answers[questionId] === rating
                    ? 'btn-primary'
                    : 'btn-secondary hover:opacity-70'
                }`}
              >
                {rating}
              </button>
            ))}
          </div>
        );

      case 'date':
        return (
          <input
            type="date"
            value={answers[questionId] || ''}
            onChange={(e) => handleAnswerChange(questionId, e.target.value)}
            required={question.required}
            className="w-full px-4 py-2 rounded border-2 focus:outline-none focus:ring-2 theme-transition"
          />
        );

      case 'file':
        return (
          <div className="text-sm opacity-70">
            File upload functionality requires additional setup (storage service)
          </div>
        );

      default:
        return null;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader size="lg" />
      </div>
    );
  }

  if (error && !form) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center">
          <p className="text-xl mb-4">{error}</p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <FiCheckCircle size={64} className="mx-auto mb-4 text-green-600" />
          <h1 className="text-3xl font-bold mb-2">Thank You!</h1>
          <p className="opacity-70">Your response has been recorded successfully.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="container mx-auto max-w-3xl">
        <div className={`border-2 ${theme === 'light' ? 'border-black' : 'border-white'} rounded p-8 mb-6`}>
          <h1 className="text-3xl font-bold mb-2">{form.title}</h1>
          {form.description && (
            <p className="opacity-70">{form.description}</p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-4 border-2 border-red-500 rounded bg-red-50 text-red-700">
              {error}
            </div>
          )}

          {questions.map((question) => (
            <div
              key={question._id}
              className={`border-2 ${theme === 'light' ? 'border-black' : 'border-white'} rounded p-6`}
            >
              <label className="block mb-4">
                <span className="font-medium text-lg">
                  {question.label}
                  {question.required && <span className="text-red-600 ml-1">*</span>}
                </span>
              </label>
              {renderQuestion(question)}
            </div>
          ))}

          <button
            type="submit"
            disabled={submitting}
            className="w-full btn-primary py-3 rounded font-medium hover:opacity-80 transition disabled:opacity-50"
          >
            {submitting ? 'Submitting...' : 'Submit'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default PublicForm;
