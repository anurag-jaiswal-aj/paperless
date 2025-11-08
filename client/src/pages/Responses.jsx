import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import api from '../utils/api';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { FiDownload, FiZap, FiArrowLeft } from 'react-icons/fi';
import Loader from '../components/Loader';

const COLORS = ['#000000', '#666666', '#999999', '#CCCCCC', '#333333', '#777777'];

const Responses = () => {
  const { id } = useParams();
  const { theme } = useSelector((state) => state.theme);
  const [form, setForm] = useState(null);
  const [responses, setResponses] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState('');
  const [generatingSummary, setGeneratingSummary] = useState(false);

  useEffect(() => {
    fetchData();
  }, [id]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [formRes, responsesRes, analyticsRes] = await Promise.all([
        api.get(`/api/forms/${id}`),
        api.get(`/api/responses/${id}`),
        api.get(`/api/responses/${id}/analytics`)
      ]);

      setForm(formRes.data.data.form);
      setResponses(responsesRes.data.data);
      setAnalytics(analyticsRes.data.data);
    } catch (err) {
      alert('Failed to load responses');
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async (format) => {
    try {
      const response = await api.get(`/api/responses/${id}/export?format=${format}`, {
        responseType: format === 'csv' ? 'blob' : 'json'
      });

      if (format === 'csv') {
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `responses-${id}.csv`);
        document.body.appendChild(link);
        link.click();
        link.remove();
      } else {
        const dataStr = JSON.stringify(response.data.data, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = window.URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `responses-${id}.json`);
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
    } catch (err) {
      alert('Failed to export responses');
    }
  };

  const handleGenerateSummary = async () => {
    setGeneratingSummary(true);
    try {
      const response = await api.post(`/api/ai/summary/${id}`);
      if (response.data.success) {
        setSummary(response.data.data.summary);
      }
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to generate summary. Check your API key.');
    } finally {
      setGeneratingSummary(false);
    }
  };

  const renderChart = (analyticsItem) => {
    if (analyticsItem.data.type === 'options') {
      // Bar chart for choice questions
      const chartData = Object.entries(analyticsItem.data.counts).map(([name, value]) => ({
        name,
        value
      }));

      return (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme === 'light' ? '#ccc' : '#444'} />
            <XAxis dataKey="name" stroke={theme === 'light' ? '#000' : '#fff'} />
            <YAxis stroke={theme === 'light' ? '#000' : '#fff'} />
            <Tooltip 
              contentStyle={{ 
                backgroundColor: theme === 'light' ? '#fff' : '#000',
                border: `1px solid ${theme === 'light' ? '#000' : '#fff'}`
              }} 
            />
            <Bar dataKey="value" fill={theme === 'light' ? '#000' : '#fff'} />
          </BarChart>
        </ResponsiveContainer>
      );
    } else if (analyticsItem.data.type === 'rating') {
      // Bar chart for ratings
      const chartData = Object.entries(analyticsItem.data.distribution).map(([rating, count]) => ({
        name: `${rating} ★`,
        value: count
      }));

      return (
        <div>
          <div className="mb-4 text-lg font-medium">
            Average: {analyticsItem.data.average} / 5
          </div>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={theme === 'light' ? '#ccc' : '#444'} />
              <XAxis dataKey="name" stroke={theme === 'light' ? '#000' : '#fff'} />
              <YAxis stroke={theme === 'light' ? '#000' : '#fff'} />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: theme === 'light' ? '#fff' : '#000',
                  border: `1px solid ${theme === 'light' ? '#000' : '#fff'}`
                }} 
              />
              <Bar dataKey="value" fill={theme === 'light' ? '#000' : '#fff'} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      );
    } else {
      return (
        <div className="text-sm opacity-70">
          {analyticsItem.totalAnswers} text responses
        </div>
      );
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader size="lg" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        {/* Header */}
        <div className="flex justify-between items-start mb-8">
          <div>
            <Link to="/dashboard" className="text-sm opacity-70 hover:opacity-100 flex items-center gap-1 mb-2">
              <FiArrowLeft /> Back to Dashboard
            </Link>
            <h1 className="text-3xl font-bold mb-2">{form?.title}</h1>
            <p className="opacity-70">{analytics?.totalResponses || 0} responses</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => handleExport('json')}
              className="btn-secondary px-4 py-2 rounded flex items-center gap-2 hover:opacity-70 transition"
            >
              <FiDownload /> Export JSON
            </button>
            <button
              onClick={() => handleExport('csv')}
              className="btn-secondary px-4 py-2 rounded flex items-center gap-2 hover:opacity-70 transition"
            >
              <FiDownload /> Export CSV
            </button>
          </div>
        </div>

        {responses.length === 0 ? (
          <div className="text-center py-16 opacity-70">
            <p className="text-xl">No responses yet</p>
            <p className="mt-2">Share your form to start collecting responses</p>
          </div>
        ) : (
          <>
            {/* AI Summary */}
            <div className={`border-2 ${theme === 'light' ? 'border-black' : 'border-white'} rounded p-6 mb-8`}>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold">AI Summary</h2>
                <button
                  onClick={handleGenerateSummary}
                  disabled={generatingSummary}
                  className="btn-primary px-4 py-2 rounded flex items-center gap-2 hover:opacity-70 transition disabled:opacity-50"
                >
                  <FiZap /> {generatingSummary ? 'Generating...' : 'Generate Summary'}
                </button>
              </div>
              {summary ? (
                <p className="opacity-80 whitespace-pre-wrap">{summary}</p>
              ) : (
                <p className="opacity-50 italic">Click above to generate an AI-powered summary of responses</p>
              )}
            </div>

            {/* Analytics Charts */}
            <h2 className="text-2xl font-bold mb-6">Analytics</h2>
            <div className="space-y-8">
              {analytics?.analytics.map((item) => (
                <div
                  key={item.questionId}
                  className={`border-2 ${theme === 'light' ? 'border-black' : 'border-white'} rounded p-6`}
                >
                  <h3 className="text-lg font-bold mb-4">{item.label}</h3>
                  <p className="text-sm opacity-70 mb-4">{item.totalAnswers} answers</p>
                  {renderChart(item)}
                </div>
              ))}
            </div>

            {/* Individual Responses */}
            <h2 className="text-2xl font-bold mt-12 mb-6">Individual Responses</h2>
            <div className="space-y-4">
              {responses.map((response, index) => (
                <div
                  key={response._id}
                  className={`border-2 ${theme === 'light' ? 'border-black' : 'border-white'} rounded p-6`}
                >
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold">Response #{responses.length - index}</h3>
                    <span className="text-sm opacity-70">
                      {new Date(response.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="space-y-3">
                    {response.answers.map((answer) => (
                      <div key={answer._id}>
                        <p className="font-medium text-sm opacity-70 mb-1">
                          {answer.questionId?.label || 'Question'}
                        </p>
                        <p>
                          {Array.isArray(answer.value) 
                            ? answer.value.join(', ') 
                            : answer.value}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Responses;
