import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import api from '../utils/api';
import Loader from '../components/Loader';
import { FiCheckCircle, FiAlertCircle } from 'react-icons/fi';

const PublicForm = () => {
  const { id } = useParams();
  const [form, setForm] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const isQuestionVisible = (question) => {
    if (!question.visibilityRule || !question.visibilityRule.targetQuestionId) {
      return true;
    }
    const { targetQuestionId, operator, value } = question.visibilityRule;
    const targetAnswer = answers[targetQuestionId];

    if (targetAnswer === undefined || targetAnswer === null || targetAnswer === '') {
      return false;
    }

    switch (operator) {
      case 'equals':
        return String(targetAnswer) === String(value);
      case 'not_equals':
        return String(targetAnswer) !== String(value);
      case 'contains':
        if (Array.isArray(targetAnswer)) return targetAnswer.includes(value);
        return String(targetAnswer).includes(String(value));
      default:
        return true;
    }
  };

  const fetchForm = useCallback(async () => {
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
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line
    fetchForm();
  }, [fetchForm]);

  const handleAnswerChange = (questionId, value) => {
    setAnswers({
      ...answers,
      [questionId]: value
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // Validate required questions (only visible ones)
    const visibleQuestions = questions.filter(isQuestionVisible);
    const requiredQuestions = visibleQuestions.filter((q) => q.required);
    for (const q of requiredQuestions) {
      if (answers[q._id] === undefined || answers[q._id] === '' || (Array.isArray(answers[q._id]) && answers[q._id].length === 0)) {
        setError(`Please answer: ${q.label}`);
        return;
      }
    }

    setSubmitting(true);

    try {
      const formattedAnswers = Object.entries(answers)
        .filter(([qId]) => {
          const q = questions.find(question => question._id === qId);
          return q && isQuestionVisible(q);
        })
        .map(([questionId, value]) => ({
          questionId,
          value
        }));

      const hasFiles = formattedAnswers.some(ans => ans.value instanceof File);

      let response;
      if (hasFiles) {
        const formData = new FormData();

        // Strip out file objects from the JSON answers array to avoid sending empty {}
        const jsonAnswers = formattedAnswers.map(ans => {
          if (ans.value instanceof File) {
            return { questionId: ans.questionId, value: null };
          }
          return ans;
        });

        formData.append('answers', JSON.stringify(jsonAnswers));

        formattedAnswers.forEach(ans => {
          if (ans.value instanceof File) {
            formData.append(`file_${ans.questionId}`, ans.value);
          }
        });

        response = await api.post(`/api/responses/${id}`, formData, {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        });
      } else {
        response = await api.post(`/api/responses/${id}`, { answers: formattedAnswers });
      }

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
            className="input"
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
            className="input"
            placeholder="Your answer"
          />
        );

      case 'number':
        return (
          <input
            type="number"
            value={answers[questionId] || ''}
            onChange={(e) => handleAnswerChange(questionId, e.target.value)}
            required={question.required}
            className="input"
            placeholder="Your answer"
          />
        );

      case 'email':
        return (
          <input
            type="email"
            value={answers[questionId] || ''}
            onChange={(e) => handleAnswerChange(questionId, e.target.value)}
            required={question.required}
            className="input"
            placeholder="Your answer"
          />
        );

      case 'single_choice':
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

      case 'multiple_choice':
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
            className="input"
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
          <div className="flex gap-3">
            {[1, 2, 3, 4, 5].map((rating) => (
              <button
                key={rating}
                type="button"
                onClick={() => handleAnswerChange(questionId, rating)}
                className={`w-12 h-12 rounded-xl border-2 font-bold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                  answers[questionId] === rating
                    ? 'border-gray-900 bg-gray-900 text-white dark:border-text-primary dark:bg-text-primary dark:text-surface-app shadow-md scale-105'
                    : 'border-gray-200 bg-transparent text-gray-700 dark:border-border-default dark:text-text-secondary hover:border-gray-400 dark:hover:border-border-strong hover:bg-gray-50 dark:hover:bg-surface-hover'
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
            className="input"
          />
        );

      case 'file':
        return (
          <input
            type="file"
            onChange={(e) => handleAnswerChange(questionId, e.target.files[0])}
            required={question.required && !answers[questionId]}
            className="input file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-gray-100 dark:file:bg-surface-input file:text-black dark:file:text-text-primary"
          />
        );

      default:
        return null;
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader size="lg" />
      </div>
    );
  }

  if (error && !form) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 theme-transition">
        <div className="text-center card p-10 max-w-md w-full">
          <div className="bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6">
            <FiAlertCircle size={32} />
          </div>
          <h2 className="text-2xl font-bold mb-3">Oops!</h2>
          <p className="opacity-70">{error}</p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 theme-transition">
        <div className="text-center card p-12 max-w-md w-full">
          <div className="bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6">
            <FiCheckCircle size={40} />
          </div>
          <h1 className="text-3xl font-bold mb-3">Thank You!</h1>
          <p className="opacity-70 text-lg">Your response has been recorded successfully.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 py-16 md:py-24 px-4 theme-transition">
      <div className="container mx-auto max-w-3xl">
        <div className={`card p-8 md:p-10 mb-8 border-t-8 border-t-gray-900 dark:border-t-text-primary`}>
          <h1 className="text-3xl md:text-4xl font-extrabold mb-4">{form.title}</h1>
          {form.description && (
            <p className="opacity-70 text-lg">{form.description}</p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-8">
          {error && (
            <div className="p-4 rounded-xl bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border border-red-200 dark:border-red-800 flex items-center gap-3">
              <FiAlertCircle className="w-5 h-5 flex-shrink-0" />
              <p>{error}</p>
            </div>
          )}

          {questions.filter(isQuestionVisible).map((question) => (
            <div
              key={question._id}
              className={`card p-6 md:p-8`}
            >
              <label className="block mb-5">
                <span className="font-semibold text-lg md:text-xl">
                  {question.label}
                  {question.required && <span className="text-red-600 dark:text-red-400 ml-1.5">*</span>}
                </span>
              </label>
              {renderQuestion(question)}
            </div>
          ))}

          <div className="pt-4">
            <button
              type="submit"
              disabled={submitting}
              className="btn btn-lg w-full btn-primary"
            >
              {submitting ? 'Submitting...' : 'Submit Response'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PublicForm;
