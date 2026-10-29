import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import api from '../utils/api';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { FiDownload, FiZap, FiArrowLeft, FiBarChart2 } from 'react-icons/fi';
import Loader from '../components/Loader';

const getQuestionId = (questionRef) => {
  if (!questionRef) return null;
  if (typeof questionRef === 'string') return questionRef;
  if (typeof questionRef === 'object') {
    if (questionRef._id) return String(questionRef._id);
    if (questionRef.id) return String(questionRef.id);
  }
  return null;
};

const formatFileSize = (bytes) => {
  if (typeof bytes !== 'number' || isNaN(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const renderAnswerContent = (answer, response, formId) => {
  if (answer == null || answer.value == null) {
    return null;
  }

  const { value } = answer;

  if (Array.isArray(value)) {
    return <span>{value.join(', ')}</span>;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span>{String(value)}</span>;
  }

  if (typeof value === 'object') {
    const isFileAnswer =
      Boolean(value.originalName) ||
      Boolean(value.key) ||
      Boolean(value.mimeType) ||
      Boolean(value.fileName) ||
      Boolean(value.filename) ||
      answer.questionId?.type === 'file' ||
      answer.questionId?.type === 'file_upload';

    if (isFileAnswer) {
      const fileName =
        value.originalName ||
        value.fileName ||
        value.filename ||
        (typeof value.key === 'string' ? value.key.split('/').pop() : null) ||
        'Download file';

      const questionId = getQuestionId(answer.questionId);
      const respId = response?._id;
      const fileSizeText = formatFileSize(value.size);

      if (formId && respId && questionId) {
        const downloadUrl = `/api/responses/${encodeURIComponent(formId)}/${encodeURIComponent(respId)}/file/${encodeURIComponent(questionId)}`;
        return (
          <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-primary hover:underline font-medium break-all"
            aria-label={`Download ${fileName}`}
          >
            <FiDownload className="shrink-0" size={16} />
            <span>{fileName}</span>
            {fileSizeText && (
              <span className="text-xs opacity-60 font-normal">({fileSizeText})</span>
            )}
          </a>
        );
      }

      return (
        <span className="inline-flex items-center gap-1.5 text-sm opacity-80 break-all">
          <FiDownload className="shrink-0" size={16} />
          <span>{fileName}</span>
          {fileSizeText && (
            <span className="text-xs opacity-60 font-normal">({fileSizeText})</span>
          )}
        </span>
      );
    }

    try {
      const json = JSON.stringify(value);
      return <span>{json === '{}' ? '' : json}</span>;
    } catch (e) {
      return <span>[Object]</span>;
    }
  }

  return <span>{String(value)}</span>;
};

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
    if (analyticsItem.data?.type === 'options') {
      // Bar chart for choice questions
      let chartData = [];
      if (Array.isArray(analyticsItem.data?.distribution)) {
        chartData = analyticsItem.data.distribution.map((item) => ({
          name: item.option,
          value: item.count
        }));
      } else if (analyticsItem.data?.counts && typeof analyticsItem.data.counts === 'object') {
        chartData = Object.entries(analyticsItem.data.counts).map(([name, value]) => ({
          name,
          value
        }));
      }

      if (chartData.length === 0) {
        return (
          <div className="text-sm opacity-70">
            No options data available
          </div>
        );
      }

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
    } else if (analyticsItem.data?.type === 'number') {
      const { min, max, average } = analyticsItem.data || {};
      if (average === null || average === undefined) {
        return (
          <div className="text-sm opacity-70">
            No numeric responses recorded
          </div>
        );
      }

      return (
        <div className="grid grid-cols-3 gap-4">
          <div className="p-4 bg-gray-50 dark:bg-surface-hover rounded-xl border border-gray-100 dark:border-border-default text-center">
            <span className="text-xs uppercase tracking-wider opacity-70 block mb-1">Average</span>
            <span className="text-2xl font-bold">{average}</span>
          </div>
          <div className="p-4 bg-gray-50 dark:bg-surface-hover rounded-xl border border-gray-100 dark:border-border-default text-center">
            <span className="text-xs uppercase tracking-wider opacity-70 block mb-1">Min</span>
            <span className="text-2xl font-bold">{min ?? 'N/A'}</span>
          </div>
          <div className="p-4 bg-gray-50 dark:bg-surface-hover rounded-xl border border-gray-100 dark:border-border-default text-center">
            <span className="text-xs uppercase tracking-wider opacity-70 block mb-1">Max</span>
            <span className="text-2xl font-bold">{max ?? 'N/A'}</span>
          </div>
        </div>
      );
    } else if (analyticsItem.data?.type === 'rating') {
      // Bar chart for ratings
      const distribution = analyticsItem.data?.distribution && typeof analyticsItem.data.distribution === 'object'
        ? analyticsItem.data.distribution
        : {};
      const chartData = Object.entries(distribution).map(([rating, count]) => ({
        name: `${rating} ★`,
        value: count
      }));

      return (
        <div>
          <div className="mb-4 text-lg font-medium">
            Average: {analyticsItem.data?.average ?? 0} / 5
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
      <div className="flex-1 flex items-center justify-center">
        <Loader size="lg" />
      </div>
    );
  }

  return (
    <div className="flex-1">
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
            <div className="bg-gray-100 dark:bg-surface-elevated p-4 rounded-full mb-4">
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
                        <div key={idx} className="p-5 bg-gray-50 dark:bg-surface-hover rounded-xl border border-gray-100 dark:border-border-default">
                          <div className="flex justify-between items-start mb-3">
                            <h3 className="font-bold text-lg">{themeItem.name}</h3>
                            {themeItem.sentiment && <span className="text-xs font-semibold px-2 py-1 rounded bg-white dark:bg-surface-card shadow-sm uppercase">{themeItem.sentiment}</span>}
                          </div>
                          <p className="text-sm opacity-90 mb-4">{themeItem.description}</p>
                          {themeItem.supportingResponses && themeItem.supportingResponses.length > 0 && (
                            <div className="text-sm opacity-70 border-t border-gray-200 dark:border-border-default pt-3">
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
                          <div key={idx} className="p-5 bg-gray-50 dark:bg-surface-hover rounded-xl border border-gray-100 dark:border-border-default">
                            <h3 className="font-bold text-lg mb-2">{cat.name} <span className="opacity-70 font-normal text-sm ml-2 bg-white dark:bg-surface-card px-2 py-1 rounded-md shadow-sm">{(cat.responseIndexes || []).length} responses</span></h3>
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
                      <div className="mt-4 p-5 bg-gray-50 dark:bg-surface-hover rounded-xl border border-gray-100 dark:border-border-default">
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
                        <div className="text-base">
                          {renderAnswerContent(answer, response, id || form?._id)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {totalPages > 1 && (
                <div className="flex justify-between items-center mt-8 p-4 bg-white dark:bg-surface-card rounded-xl border shadow-sm">
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
