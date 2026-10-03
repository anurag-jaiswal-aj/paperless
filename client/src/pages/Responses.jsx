import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import api from '../utils/api';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { FiDownload, FiZap, FiArrowLeft, FiBarChart2 } from 'react-icons/fi';
import Loader from '../components/Loader';

const Responses = () => {
  const { id } = useParams();
  const { theme } = useSelector((state) => state.theme);
  const [form, setForm] = useState(null);
  const [responses, setResponses] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState('');
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [themes, setThemes] = useState(null);
  const [generatingThemes, setGeneratingThemes] = useState(false);
  const [categories, setCategories] = useState(null);
  const [generatingCategories, setGeneratingCategories] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchResponses = async (pageNum) => {
    try {
      const res = await api.get(`/api/responses/${id}?page=${pageNum}&limit=10`);
      setResponses(res.data.data);
      setTotalPages(res.data.pagination.pages);
      setPage(res.data.pagination.page);
    } catch (err) {
      console.error('Failed to load page', err);
    }
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [formRes, responsesRes, analyticsRes] = await Promise.all([
        api.get(`/api/forms/${id}`),
        api.get(`/api/responses/${id}?page=1&limit=10`),
        api.get(`/api/responses/${id}/analytics`)
      ]);

      setForm(formRes.data.data.form);
      setResponses(responsesRes.data.data);
      setTotalPages(responsesRes.data.pagination.pages);
      setAnalytics(analyticsRes.data.data);
    } catch (err) {
      alert('Failed to load responses');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line
    fetchData();
  }, [fetchData]);

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
      const response = await api.post(`/api/ai/responses/summary/${id}`);
      if (response.data.success) {
        setSummary(response.data.data);
      }
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to generate summary. Check your API key.');
    } finally {
      setGeneratingSummary(false);
    }
  };

  const handleExtractThemes = async () => {
    setGeneratingThemes(true);
    try {
      const response = await api.post(`/api/ai/responses/themes/${id}`);
      if (response.data.success) {
        setThemes(response.data.data.themes);
      }
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to extract themes.');
    } finally {
      setGeneratingThemes(false);
    }
  };

  const handleCategorize = async () => {
    setGeneratingCategories(true);
    try {
      const response = await api.post(`/api/ai/responses/categorize/${id}`);
      if (response.data.success) {
        setCategories(response.data.data);
      }
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to categorize responses.');
    } finally {
      setGeneratingCategories(false);
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
              className="btn btn-secondary"
            >
              <FiDownload /> Export JSON
            </button>
            <button
              onClick={() => handleExport('csv')}
              className="btn btn-secondary"
            >
              <FiDownload /> Export CSV
            </button>
          </div>
        </div>

        {responses.length === 0 ? (
          <div className="text-center py-20 px-4 card flex flex-col items-center justify-center bg-transparent border-dashed">
            <div className="bg-gray-100 dark:bg-gray-800 p-4 rounded-full mb-4">
              <FiBarChart2 className="w-8 h-8 opacity-50" />
            </div>
            <h3 className="text-xl font-bold mb-2">No responses yet</h3>
            <p className="opacity-70 max-w-sm mx-auto">Share your form to start collecting responses and analyzing data.</p>
          </div>
        ) : (
          <>
            {/* AI Intelligence */}
            <div className="space-y-6 mb-8">
              {/* Summary */}
              <div className={`card p-6`}>
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-xl font-bold">AI Summary</h2>
                  <button
                    onClick={handleGenerateSummary}
                    disabled={generatingSummary}
                    className="btn btn-primary"
                  >
                    <FiZap className="inline mr-1" /> {generatingSummary ? 'Generating...' : 'Generate Summary'}
                  </button>
                </div>
                {summary ? (
                  <div className="space-y-4">
                    <p className="font-semibold text-lg">{summary.overview}</p>
                    {summary.keyInsights && summary.keyInsights.length > 0 && (
                      <div>
                        <h3 className="font-bold mb-2">Key Insights</h3>
                        <ul className="list-disc pl-5 space-y-2">
                          {summary.keyInsights.map((insight, idx) => (
                            <li key={idx}>
                              <span className="font-semibold">{insight.title}:</span> {insight.explanation}
                              {insight.sentiment && <span className="text-xs opacity-70 ml-2 px-2 py-1 rounded bg-gray-500 bg-opacity-20 uppercase tracking-wider">{insight.sentiment}</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {summary.caveats && summary.caveats.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-gray-500 border-opacity-30">
                        <h4 className="text-sm font-bold opacity-70">Caveats</h4>
                        <ul className="list-disc pl-5 text-sm opacity-70">
                          {summary.caveats.map((c, idx) => <li key={idx}>{c}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="opacity-50 italic">Click above to generate an AI-powered summary of responses</p>
                )}
              </div>

              {/* Themes */}
              <div className={`card p-6`}>
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-xl font-bold">Theme Extraction</h2>
                  <button
                    onClick={handleExtractThemes}
                    disabled={generatingThemes}
                    className="btn btn-primary"
                  >
                    <FiZap className="inline mr-1" /> {generatingThemes ? 'Extracting...' : 'Extract Themes'}
                  </button>
                </div>
                {themes ? (
                  themes.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {themes.map((themeItem, idx) => (
                        <div key={idx} className="p-5 bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-100 dark:border-gray-800">
                          <div className="flex justify-between items-start mb-3">
                            <h3 className="font-bold text-lg">{themeItem.name}</h3>
                            {themeItem.sentiment && <span className="text-xs font-semibold px-2 py-1 rounded bg-white dark:bg-gray-900 shadow-sm uppercase">{themeItem.sentiment}</span>}
                          </div>
                          <p className="text-sm opacity-90 mb-4">{themeItem.description}</p>
                          {themeItem.supportingResponses && themeItem.supportingResponses.length > 0 && (
                            <div className="text-sm opacity-70 border-t border-gray-200 dark:border-gray-700 pt-3">
                              <p className="font-semibold mb-2">Examples:</p>
                              <ul className="list-disc pl-4 space-y-1.5">
                                {themeItem.supportingResponses.map((r, i) => <li key={i} className="italic">&quot;{r}&quot;</li>)}
                              </ul>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="opacity-70">No themes could be extracted.</p>
                  )
                ) : (
                  <p className="opacity-50 italic">Extract common themes from text responses.</p>
                )}
              </div>

              {/* Categorization */}
              <div className={`card p-6`}>
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-xl font-bold">Response Categorization</h2>
                  <button
                    onClick={handleCategorize}
                    disabled={generatingCategories}
                    className="btn btn-primary"
                  >
                    <FiZap className="inline mr-1" /> {generatingCategories ? 'Categorizing...' : 'Categorize'}
                  </button>
                </div>
                {categories ? (
                  <div>
                    {categories.categories && categories.categories.length > 0 && (
                      <div className="space-y-4">
                        {categories.categories.map((cat, idx) => (
                          <div key={idx} className="p-5 bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-100 dark:border-gray-800">
                            <h3 className="font-bold text-lg mb-2">{cat.name} <span className="opacity-70 font-normal text-sm ml-2 bg-white dark:bg-gray-900 px-2 py-1 rounded-md shadow-sm">{(cat.responseIndexes || []).length} responses</span></h3>
                            <p className="text-sm opacity-90 mb-3">{cat.description}</p>
                            {(cat.responseIndexes || []).length > 0 && (
                              <p className="text-xs opacity-70">
                                Includes Response IDs: {(cat.responseIndexes || []).map(i => {
                                  const r = responses[i];
                                  return r ? `#${responses.length - i}` : `#Unknown`;
                                }).join(', ')}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {categories.uncategorizedResponseIndexes && categories.uncategorizedResponseIndexes.length > 0 && (
                      <div className="mt-4 p-5 bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-100 dark:border-gray-800">
                        <h3 className="font-bold text-lg mb-2 opacity-70">Uncategorized</h3>
                        <p className="text-xs opacity-70">
                          Response IDs: {categories.uncategorizedResponseIndexes.map(i => {
                            const r = responses[i];
                            return r ? `#${responses.length - i}` : `#Unknown`;
                          }).join(', ')}
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="opacity-50 italic">Categorize text responses automatically.</p>
                )}
              </div>
            </div>

            {/* Analytics Charts */}
            <h2 className="text-2xl font-bold mb-6">Analytics</h2>
            <div className="space-y-8">
              {analytics?.analytics.map((item) => (
                <div
                  key={item.questionId}
                  className={`card p-6`}
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
                  className={`card p-6`}
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

              {totalPages > 1 && (
                <div className="flex justify-between items-center mt-8 p-4 bg-white dark:bg-gray-900 rounded-xl border shadow-sm">
                  <button
                    disabled={page === 1}
                    onClick={() => fetchResponses(page - 1)}
                    className="btn btn-secondary"
                  >
                    Previous
                  </button>
                  <span className="opacity-70 font-medium">
                    Page {page} of {totalPages}
                  </span>
                  <button
                    disabled={page === totalPages}
                    onClick={() => fetchResponses(page + 1)}
                    className="btn btn-secondary"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Responses;
