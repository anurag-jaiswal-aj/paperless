import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { DragDropContext, Draggable } from 'react-beautiful-dnd';
import { StrictModeDroppable } from '../components/StrictModeDroppable';
import { setCurrentForm, setQuestions, addQuestion, updateQuestion, removeQuestion, reorderQuestions, setLoading } from '../store/formSlice';
import api from '../utils/api';
import { FiPlus, FiTrash2, FiMove, FiZap } from 'react-icons/fi';
import Loader from '../components/Loader';
import CustomSelect from '../components/CustomSelect';

const QUESTION_TYPES = [
  { value: 'short_text', label: 'Short Text' },
  { value: 'long_text', label: 'Long Text' },
  { value: 'number', label: 'Number' },
  { value: 'email', label: 'Email' },
  { value: 'single_choice', label: 'Single Choice' },
  { value: 'multiple_choice', label: 'Multiple Choice' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'rating', label: 'Rating' },
  { value: 'date', label: 'Date' },
  { value: 'file', label: 'File Upload' }
];

const MAX_OCC_RETRIES = 3;

const FormBuilder = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { currentForm, questions, loading } = useSelector((state) => state.forms);
  const questionsRef = useRef(questions);
  useEffect(() => {
    questionsRef.current = questions;
  }, [questions]);

  const [formData, setFormData] = useState(() => ({
    title: currentForm?.title || '',
    description: currentForm?.description || '',
    status: currentForm?.status || 'draft'
  }));
  const formDataRef = useRef(formData);
  const lastSavedFormRef = useRef({
    title: currentForm?.title || '',
    description: currentForm?.description || '',
    status: currentForm?.status || 'draft'
  });
  const formUpdateSeqRef = useRef(0);
  const formPendingTimerRef = useRef(null);

  const [saveStatus, setSaveStatus] = useState('saved'); // 'saved' | 'saving' | 'error' | 'unsaved'
  const questionVersionsRef = useRef({});
  const formVersionRef = useRef(undefined);
  const questionConflictRetriesRef = useRef({});
  const formConflictRetriesRef = useRef(0);
  const questionInFlightRef = useRef({});
  const formInFlightRef = useRef(false);
  const formPendingUpdatesRef = useRef({});
  const flushQuestionUpdateRef = useRef();
  const flushFormUpdateRef = useRef();

  const isMountedRef = useRef(true);
  const activeFormIdRef = useRef(id);

  const statusUpdateSeqRef = useRef(0);
  const questionSeqRef = useRef({});
  const questionPendingTimersRef = useRef({});
  const questionPendingUpdatesRef = useRef({});
  const deletedQuestionsRef = useRef(new Set());

  const [showAIModal, setShowAIModal] = useState(false);
  const [aiTopic, setAiTopic] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [showImproveModal, setShowImproveModal] = useState(false);
  const [improveTarget, setImproveTarget] = useState(null);
  const [improvements, setImprovements] = useState(null);
  const [showConsultantModal, setShowConsultantModal] = useState(false);
  const [consultantData, setConsultantData] = useState(null);
  const [proposedQuestions, setProposedQuestions] = useState([]);

  const checkIfAllSaved = useCallback(() => {
    const hasPendingQuestions = Object.values(questionPendingUpdatesRef.current).some(
      (u) => u && Object.keys(u).length > 0
    );
    const hasPendingForm = Object.keys(formPendingUpdatesRef.current).length > 0;
    const isQuestionInFlight = Object.values(questionInFlightRef.current).some(Boolean);
    const isFormInFlight = formInFlightRef.current;

    if (!hasPendingQuestions && !hasPendingForm && !isQuestionInFlight && !isFormInFlight) {
      setSaveStatus('saved');
    }
  }, []);

  const fetchFormData = useCallback(async () => {
    dispatch(setLoading(true));
    try {
      const response = await api.get(`/api/forms/${id}`);
      if (response?.data?.success && response.data?.data) {
        dispatch(setCurrentForm(response.data.data.form));
        dispatch(setQuestions(response.data.data.questions));
        const loadedForm = response.data.data.form;

        if (loadedForm?.version !== undefined) {
          formVersionRef.current = loadedForm.version;
        }

        if (Array.isArray(response.data.data.questions)) {
          response.data.data.questions.forEach((q) => {
            if (q.version !== undefined) {
              questionVersionsRef.current[q._id] = q.version;
            }
          });
        }

        const newFormState = {
          title: loadedForm.title || '',
          description: loadedForm.description || '',
          status: loadedForm.status || 'draft'
        };
        setFormData((prev) => {
          if (!prev.title && !prev.description) {
            formDataRef.current = newFormState;
            lastSavedFormRef.current = { ...newFormState };
            return newFormState;
          }
          lastSavedFormRef.current = { ...newFormState };
          return prev;
        });
        setSaveStatus('saved');
      }
    } catch (err) {
      alert('Failed to load form');
      navigate('/dashboard');
    }
  }, [dispatch, id, navigate]);

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      const hasPendingQuestions = Object.values(questionPendingUpdatesRef.current).some(
        (u) => u && Object.keys(u).length > 0
      );
      const hasPendingForm = Object.keys(formPendingUpdatesRef.current).length > 0;
      const isSaving =
        formInFlightRef.current || Object.values(questionInFlightRef.current).some(Boolean);

      if (hasPendingQuestions || hasPendingForm || isSaving) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  const flushQuestionUpdate = useCallback(async (questionId, explicitSeq = null) => {
    if (!isMountedRef.current || activeFormIdRef.current !== id) return;
    if (deletedQuestionsRef.current.has(questionId)) return;

    if (questionPendingTimersRef.current[questionId]) {
      clearTimeout(questionPendingTimersRef.current[questionId]);
      delete questionPendingTimersRef.current[questionId];
    }

    if (questionInFlightRef.current[questionId]) {
      return;
    }

    const updates = questionPendingUpdatesRef.current[questionId];
    if (!updates || Object.keys(updates).length === 0) return;

    const payloadToSend = { ...updates };
    delete questionPendingUpdatesRef.current[questionId];

    const seq = explicitSeq !== null ? explicitSeq : ((questionSeqRef.current[questionId] || 0) + 1);
    questionSeqRef.current[questionId] = seq;

    questionInFlightRef.current[questionId] = true;
    setSaveStatus('saving');

    const qVersion = questionVersionsRef.current[questionId];
    const requestPayload = {
      ...payloadToSend,
      ...(qVersion !== undefined ? { version: qVersion } : {})
    };

    try {
      const response = await api.put(`/api/forms/${id}/questions/${questionId}`, requestPayload);
      questionInFlightRef.current[questionId] = false;

      if (
        !isMountedRef.current ||
        activeFormIdRef.current !== id ||
        deletedQuestionsRef.current.has(questionId) ||
        seq !== questionSeqRef.current[questionId]
      ) {
        return;
      }

      if (response.data?.success && response.data?.data) {
        questionConflictRetriesRef.current[questionId] = 0;
        if (response.data.data.version !== undefined) {
          questionVersionsRef.current[questionId] = response.data.data.version;
        }

        const hasNewerPending = Boolean(
          questionPendingUpdatesRef.current[questionId] &&
          Object.keys(questionPendingUpdatesRef.current[questionId]).length > 0
        );

        const currentQ = questionsRef.current.find((q) => q._id === questionId);
        const mergedData = {
          ...response.data.data,
          order: currentQ ? currentQ.order : response.data.data.order
        };

        if (hasNewerPending) {
          Object.assign(mergedData, questionPendingUpdatesRef.current[questionId]);
        }

        dispatch(updateQuestion(mergedData));

        if (hasNewerPending) {
          flushQuestionUpdateRef.current?.(questionId);
        } else {
          checkIfAllSaved();
        }
      }
    } catch (err) {
      questionInFlightRef.current[questionId] = false;

      if (
        !isMountedRef.current ||
        activeFormIdRef.current !== id ||
        deletedQuestionsRef.current.has(questionId)
      ) {
        return;
      }

      if (err.response?.status === 409) {
        const latestServerDoc = err.response.data?.data;
        if (latestServerDoc?.version !== undefined) {
          questionVersionsRef.current[questionId] = latestServerDoc.version;
        }

        questionPendingUpdatesRef.current[questionId] = {
          ...payloadToSend,
          ...(questionPendingUpdatesRef.current[questionId] || {})
        };

        if (latestServerDoc) {
          const currentQ = questionsRef.current.find((q) => q._id === questionId);
          const userEdits = questionPendingUpdatesRef.current[questionId] || {};
          const reconciled = {
            ...latestServerDoc,
            order: currentQ ? currentQ.order : latestServerDoc.order,
            ...userEdits
          };
          dispatch(updateQuestion(reconciled));
        }

        const retries = (questionConflictRetriesRef.current[questionId] || 0) + 1;
        questionConflictRetriesRef.current[questionId] = retries;

        if (retries <= MAX_OCC_RETRIES) {
          flushQuestionUpdateRef.current?.(questionId);
          return;
        }

        setSaveStatus('error');
        return;
      }

      questionPendingUpdatesRef.current[questionId] = {
        ...payloadToSend,
        ...(questionPendingUpdatesRef.current[questionId] || {})
      };

      setSaveStatus('error');
      alert(err.response?.data?.message || 'Failed to update question');
    }
  }, [id, dispatch, checkIfAllSaved]);

  const flushAllPendingQuestionUpdates = useCallback(async () => {
    const pendingIds = Object.keys(questionPendingUpdatesRef.current);
    for (const qId of pendingIds) {
      if (questionPendingTimersRef.current[qId]) {
        clearTimeout(questionPendingTimersRef.current[qId]);
        delete questionPendingTimersRef.current[qId];
      }
      await flushQuestionUpdate(qId);
    }
  }, [flushQuestionUpdate]);

  const flushFormUpdate = useCallback(async () => {
    if (!isMountedRef.current || activeFormIdRef.current !== id) return;
    if (formPendingTimerRef.current) {
      clearTimeout(formPendingTimerRef.current);
      formPendingTimerRef.current = null;
    }

    if (formInFlightRef.current) return;

    const currentTitle = formPendingUpdatesRef.current.title !== undefined
      ? formPendingUpdatesRef.current.title
      : formDataRef.current.title;
    const currentDesc = formPendingUpdatesRef.current.description !== undefined
      ? formPendingUpdatesRef.current.description
      : formDataRef.current.description;

    if (
      currentTitle === lastSavedFormRef.current.title &&
      currentDesc === lastSavedFormRef.current.description &&
      Object.keys(formPendingUpdatesRef.current).length === 0
    ) {
      return;
    }

    formPendingUpdatesRef.current = {};
    formInFlightRef.current = true;
    setSaveStatus('saving');

    const currentSeq = ++formUpdateSeqRef.current;
    const requestPayload = {
      title: currentTitle,
      description: currentDesc,
      ...(formVersionRef.current !== undefined ? { version: formVersionRef.current } : {})
    };

    try {
      const response = await api.put(`/api/forms/${id}`, requestPayload);
      formInFlightRef.current = false;

      if (
        isMountedRef.current &&
        activeFormIdRef.current === id &&
        currentSeq === formUpdateSeqRef.current
      ) {
        if (response.data?.success) {
          formConflictRetriesRef.current = 0;
          if (response.data.data?.version !== undefined) {
            formVersionRef.current = response.data.data.version;
          }
          if (response.data.data?.title !== undefined) {
            lastSavedFormRef.current.title = response.data.data.title;
          } else {
            lastSavedFormRef.current.title = currentTitle;
          }
          if (response.data.data?.description !== undefined) {
            lastSavedFormRef.current.description = response.data.data.description;
          } else {
            lastSavedFormRef.current.description = currentDesc;
          }
          if (response.data.data) {
            dispatch(setCurrentForm(response.data.data));
          }

          const hasNewer = Object.keys(formPendingUpdatesRef.current).length > 0;
          if (hasNewer) {
            flushFormUpdateRef.current?.();
          } else {
            checkIfAllSaved();
          }
        }
      }
    } catch (err) {
      formInFlightRef.current = false;

      if (
        isMountedRef.current &&
        activeFormIdRef.current === id &&
        currentSeq === formUpdateSeqRef.current
      ) {
        if (err.response?.status === 409) {
          const latestDoc = err.response.data?.data;
          if (latestDoc?.version !== undefined) {
            formVersionRef.current = latestDoc.version;
          }

          const pendingEdits = {
            ...(currentTitle !== lastSavedFormRef.current.title ? { title: currentTitle } : {}),
            ...(currentDesc !== lastSavedFormRef.current.description ? { description: currentDesc } : {}),
            ...formPendingUpdatesRef.current
          };
          formPendingUpdatesRef.current = pendingEdits;

          if (latestDoc) {
            const reconciledForm = {
              ...latestDoc,
              ...formDataRef.current,
              ...pendingEdits
            };
            formDataRef.current = {
              title: reconciledForm.title || '',
              description: reconciledForm.description || '',
              status: reconciledForm.status || 'draft'
            };
            setFormData(formDataRef.current);
            dispatch(setCurrentForm(reconciledForm));
            if (!pendingEdits.title && latestDoc.title !== undefined) {
              lastSavedFormRef.current.title = latestDoc.title;
            }
            if (!pendingEdits.description && latestDoc.description !== undefined) {
              lastSavedFormRef.current.description = latestDoc.description;
            }
          }

          const retries = (formConflictRetriesRef.current || 0) + 1;
          formConflictRetriesRef.current = retries;

          if (retries <= MAX_OCC_RETRIES) {
            flushFormUpdateRef.current?.();
            return;
          }

          setSaveStatus('error');
          return;
        }

        formPendingUpdatesRef.current = {
          title: currentTitle,
          description: currentDesc,
          ...formPendingUpdatesRef.current
        };

        setSaveStatus('error');
        alert(err.response?.data?.message || 'Failed to update form');
      }
    }
  }, [id, dispatch, checkIfAllSaved]);

  useEffect(() => {
    flushQuestionUpdateRef.current = flushQuestionUpdate;
    flushFormUpdateRef.current = flushFormUpdate;
  }, [flushQuestionUpdate, flushFormUpdate]);

  useEffect(() => {
    isMountedRef.current = true;
    activeFormIdRef.current = id;
    deletedQuestionsRef.current.clear();
    questionSeqRef.current = {};
    questionPendingUpdatesRef.current = {};
    questionVersionsRef.current = {};
    questionInFlightRef.current = {};
    questionConflictRetriesRef.current = {};
    formConflictRetriesRef.current = 0;
    formInFlightRef.current = false;
    formPendingUpdatesRef.current = {};
    formVersionRef.current = undefined;

    // Clear any timers from a previous form or mount
    Object.values(questionPendingTimersRef.current).forEach(clearTimeout);
    questionPendingTimersRef.current = {};
    if (formPendingTimerRef.current) {
      clearTimeout(formPendingTimerRef.current);
      formPendingTimerRef.current = null;
    }

    fetchFormData();

    return () => {
      // Best-effort flush for any pending edits before unmounting
      flushAllPendingQuestionUpdates();
      flushFormUpdate();

      isMountedRef.current = false;
      Object.values(questionPendingTimersRef.current).forEach(clearTimeout);
      questionPendingTimersRef.current = {};
      if (formPendingTimerRef.current) {
        clearTimeout(formPendingTimerRef.current);
        formPendingTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleFormTextChange = (field, val) => {
    formDataRef.current = {
      ...formDataRef.current,
      [field]: val
    };
    setFormData(formDataRef.current);

    formPendingUpdatesRef.current = {
      ...formPendingUpdatesRef.current,
      [field]: val
    };

    setSaveStatus('unsaved');

    if (formPendingTimerRef.current) {
      clearTimeout(formPendingTimerRef.current);
    }
    formPendingTimerRef.current = setTimeout(() => {
      flushFormUpdate();
    }, 400);
  };

  const handleFormBlur = () => {
    if (formPendingTimerRef.current) {
      clearTimeout(formPendingTimerRef.current);
      formPendingTimerRef.current = null;
      flushFormUpdate();
    }
  };

  const handleStatusChange = async (newStatus) => {
    if (!newStatus || newStatus === formData.status) return;

    if (formPendingTimerRef.current) {
      clearTimeout(formPendingTimerRef.current);
      formPendingTimerRef.current = null;
      await flushFormUpdate();
    }

    const previousStatus = formData.status;
    const currentSeq = ++statusUpdateSeqRef.current;

    setFormData((prev) => {
      const updated = { ...prev, status: newStatus };
      formDataRef.current = updated;
      return updated;
    });

    const requestPayload = {
      status: newStatus,
      ...(formVersionRef.current !== undefined ? { version: formVersionRef.current } : {})
    };

    try {
      const response = await api.put(`/api/forms/${id}`, requestPayload);
      if (currentSeq === statusUpdateSeqRef.current) {
        if (response.data?.success && response.data?.data) {
          if (response.data.data.version !== undefined) {
            formVersionRef.current = response.data.data.version;
          }
          dispatch(setCurrentForm(response.data.data));
          setFormData((prev) => {
            const updated = {
              ...prev,
              status: response.data.data.status || newStatus
            };
            formDataRef.current = updated;
            return updated;
          });
          lastSavedFormRef.current.status = response.data.data.status || newStatus;
        }
      }
    } catch (err) {
      if (currentSeq === statusUpdateSeqRef.current) {
        setFormData((prev) => {
          const reverted = { ...prev, status: previousStatus };
          formDataRef.current = reverted;
          return reverted;
        });
        alert(err.response?.data?.message || 'Failed to update form status');
      }
    }
  };

  const handleDebouncedQuestionUpdate = useCallback((questionId, updates) => {
    if (deletedQuestionsRef.current.has(questionId)) return;

    // Optimistic update in Redux for immediate UI responsiveness
    dispatch(updateQuestion({ _id: questionId, ...updates }));

    // Accumulate pending updates
    questionPendingUpdatesRef.current[questionId] = {
      ...(questionPendingUpdatesRef.current[questionId] || {}),
      ...updates
    };

    setSaveStatus('unsaved');

    // Increment sequence number
    const seq = (questionSeqRef.current[questionId] || 0) + 1;
    questionSeqRef.current[questionId] = seq;

    // Schedule debounced flush
    if (questionPendingTimersRef.current[questionId]) {
      clearTimeout(questionPendingTimersRef.current[questionId]);
    }
    questionPendingTimersRef.current[questionId] = setTimeout(() => {
      flushQuestionUpdate(questionId, seq);
    }, 300);
  }, [dispatch, flushQuestionUpdate]);

  const handleImmediateQuestionUpdate = useCallback(async (questionId, updates) => {
    if (deletedQuestionsRef.current.has(questionId)) return;

    // Clear any pending debounce timer
    if (questionPendingTimersRef.current[questionId]) {
      clearTimeout(questionPendingTimersRef.current[questionId]);
      delete questionPendingTimersRef.current[questionId];
    }

    // Merge with any existing pending updates
    const combinedUpdates = {
      ...(questionPendingUpdatesRef.current[questionId] || {}),
      ...updates
    };
    delete questionPendingUpdatesRef.current[questionId];

    // Optimistic Redux update
    dispatch(updateQuestion({ _id: questionId, ...combinedUpdates }));

    // Increment sequence
    const seq = (questionSeqRef.current[questionId] || 0) + 1;
    questionSeqRef.current[questionId] = seq;

    questionInFlightRef.current[questionId] = true;
    setSaveStatus('saving');

    const qVersion = questionVersionsRef.current[questionId];
    const requestPayload = {
      ...combinedUpdates,
      ...(qVersion !== undefined ? { version: qVersion } : {})
    };

    try {
      const response = await api.put(`/api/forms/${id}/questions/${questionId}`, requestPayload);
      questionInFlightRef.current[questionId] = false;

      if (
        isMountedRef.current &&
        activeFormIdRef.current === id &&
        !deletedQuestionsRef.current.has(questionId) &&
        seq === questionSeqRef.current[questionId]
      ) {
        if (response.data?.success && response.data?.data) {
          questionConflictRetriesRef.current[questionId] = 0;
          if (response.data.data.version !== undefined) {
            questionVersionsRef.current[questionId] = response.data.data.version;
          }

          const hasNewerPending = Boolean(
            questionPendingUpdatesRef.current[questionId] &&
            Object.keys(questionPendingUpdatesRef.current[questionId]).length > 0
          );

          const currentQ = questionsRef.current.find((q) => q._id === questionId);
          const mergedData = {
            ...response.data.data,
            order: currentQ ? currentQ.order : response.data.data.order
          };

          if (hasNewerPending) {
            Object.assign(mergedData, questionPendingUpdatesRef.current[questionId]);
          }

          dispatch(updateQuestion(mergedData));

          if (hasNewerPending) {
            flushQuestionUpdate(questionId);
          } else {
            checkIfAllSaved();
          }
        }
      }
    } catch (err) {
      questionInFlightRef.current[questionId] = false;

      if (
        isMountedRef.current &&
        activeFormIdRef.current === id &&
        !deletedQuestionsRef.current.has(questionId) &&
        seq === questionSeqRef.current[questionId]
      ) {
        if (err.response?.status === 409) {
          const latestServerDoc = err.response.data?.data;
          if (latestServerDoc?.version !== undefined) {
            questionVersionsRef.current[questionId] = latestServerDoc.version;
          }

          questionPendingUpdatesRef.current[questionId] = {
            ...combinedUpdates,
            ...(questionPendingUpdatesRef.current[questionId] || {})
          };

          if (latestServerDoc) {
            const currentQ = questionsRef.current.find((q) => q._id === questionId);
            const userEdits = questionPendingUpdatesRef.current[questionId] || {};
            const reconciled = {
              ...latestServerDoc,
              order: currentQ ? currentQ.order : latestServerDoc.order,
              ...userEdits
            };
            dispatch(updateQuestion(reconciled));
          }

          const retries = (questionConflictRetriesRef.current[questionId] || 0) + 1;
          questionConflictRetriesRef.current[questionId] = retries;

          if (retries <= MAX_OCC_RETRIES) {
            flushQuestionUpdate(questionId);
            return;
          }

          setSaveStatus('error');
          return;
        }

        questionPendingUpdatesRef.current[questionId] = {
          ...combinedUpdates,
          ...(questionPendingUpdatesRef.current[questionId] || {})
        };

        setSaveStatus('error');
        alert(err.response?.data?.message || 'Failed to update question');
      }
    }
  }, [id, dispatch, flushQuestionUpdate, checkIfAllSaved]);

  const handleRetry = useCallback(() => {
    questionConflictRetriesRef.current = {};
    formConflictRetriesRef.current = 0;
    setSaveStatus('saving');
    flushAllPendingQuestionUpdates();
    flushFormUpdate();
  }, [flushAllPendingQuestionUpdates, flushFormUpdate]);

  const handleAddQuestion = async (questionData = null) => {
    flushAllPendingQuestionUpdates();

    const newQuestion = questionData || {
      type: 'short_text',
      label: 'Untitled Question',
      required: false,
      options: []
    };

    try {
      const response = await api.post(`/api/forms/${id}/questions`, newQuestion);
      if (response.data.success) {
        const createdQ = response.data.data;
        if (createdQ?._id) {
          questionVersionsRef.current[createdQ._id] =
            createdQ.version !== undefined ? createdQ.version : 0;
        }
        dispatch(addQuestion(createdQ));
      }
    } catch (err) {
      alert('Failed to add question');
    }
  };

  const handleDeleteQuestion = async (questionId) => {
    if (!confirm('Delete this question?')) return;

    // Cancel pending timers and delete pending updates for questionId
    if (questionPendingTimersRef.current[questionId]) {
      clearTimeout(questionPendingTimersRef.current[questionId]);
      delete questionPendingTimersRef.current[questionId];
    }
    delete questionPendingUpdatesRef.current[questionId];
    delete questionConflictRetriesRef.current[questionId];

    // Mark as deleted so in-flight updates are ignored
    deletedQuestionsRef.current.add(questionId);
    questionSeqRef.current[questionId] = (questionSeqRef.current[questionId] || 0) + 1;

    try {
      await api.delete(`/api/forms/${id}/questions/${questionId}`);
      dispatch(removeQuestion(questionId));
    } catch (err) {
      deletedQuestionsRef.current.delete(questionId);
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

    // Flush pending question updates so latest labels/options are saved
    flushAllPendingQuestionUpdates();

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
      await handleImmediateQuestionUpdate(improveTarget.id, { label: newText });
    } else if (improveTarget.type === 'title') {
      if (formPendingTimerRef.current) {
        clearTimeout(formPendingTimerRef.current);
        formPendingTimerRef.current = null;
      }
      formDataRef.current = {
        ...formDataRef.current,
        title: newText
      };
      setFormData(formDataRef.current);
      formPendingUpdatesRef.current = {
        ...formPendingUpdatesRef.current,
        title: newText
      };
      await flushFormUpdate();
    } else if (improveTarget.type === 'description') {
      if (formPendingTimerRef.current) {
        clearTimeout(formPendingTimerRef.current);
        formPendingTimerRef.current = null;
      }
      formDataRef.current = {
        ...formDataRef.current,
        description: newText
      };
      setFormData(formDataRef.current);
      formPendingUpdatesRef.current = {
        ...formPendingUpdatesRef.current,
        description: newText
      };
      await flushFormUpdate();
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
    <div className="flex-1">
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
                  onChange={(e) => handleFormTextChange('title', e.target.value)}
                  onBlur={handleFormBlur}
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
                  onChange={(e) => handleFormTextChange('description', e.target.value)}
                  onBlur={handleFormBlur}
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
                className="btn btn-primary"
              >
                <FiZap /> AI Suggest Questions
              </button>

              <button
                onClick={handleConsultant}
                className="btn btn-secondary"
              >
                Form Consultant
              </button>

              <div className="ml-auto flex items-center gap-3">
                {saveStatus === 'saving' && (
                  <span className="text-sm opacity-70 flex items-center gap-1.5" data-testid="save-status-saving">
                    <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    Saving...
                  </span>
                )}
                {saveStatus === 'saved' && (
                  <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1" data-testid="save-status-saved">
                    All changes saved
                  </span>
                )}
                {saveStatus === 'error' && (
                  <div className="flex items-center gap-2" data-testid="save-status-error">
                    <span className="text-sm text-red-500 font-medium">Save failed</span>
                    <button
                      type="button"
                      onClick={handleRetry}
                      className="text-xs px-2 py-0.5 bg-red-100 hover:bg-red-200 dark:bg-red-900/40 text-red-700 dark:text-red-300 rounded font-medium transition"
                    >
                      Retry
                    </button>
                  </div>
                )}
                <span className="text-sm opacity-70">Status:</span>
                <CustomSelect
                  value={formData.status}
                  onChange={handleStatusChange}
                  options={[
                    { value: 'draft', label: 'Draft' },
                    { value: 'published', label: 'Published' },
                    { value: 'closed', label: 'Closed' }
                  ]}
                  className="max-w-[120px]"
                />
              </div>
            </div>

            {/* Questions */}
            <DragDropContext onDragEnd={handleDragEnd}>
              <StrictModeDroppable droppableId="questions">
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
                                    onChange={(e) => handleDebouncedQuestionUpdate(question._id, { label: e.target.value })}
                                    onBlur={() => flushQuestionUpdate(question._id)}
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
                                  <CustomSelect
                                    value={question.type === 'checkbox' ? 'multiple_choice' : question.type}
                                    onChange={(val) => handleImmediateQuestionUpdate(question._id, { type: val })}
                                    options={QUESTION_TYPES}
                                  />

                                  <label className="flex items-center gap-2 text-sm">
                                    <input
                                      type="checkbox"
                                      checked={Boolean(question.required)}
                                      onChange={(e) => handleImmediateQuestionUpdate(question._id, { required: e.target.checked })}
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
                                    <CustomSelect
                                      value={question.visibilityRule?.targetQuestionId || ''}
                                      onChange={(val) => {
                                        const newRule = val
                                          ? { targetQuestionId: val, operator: 'equals', value: '' }
                                          : null;
                                        handleImmediateQuestionUpdate(question._id, { visibilityRule: newRule });
                                      }}
                                      options={[
                                        { value: '', label: 'Always Visible' },
                                        ...questions
                                          .filter(q => q._id !== question._id && q.order < question.order)
                                          .map(q => ({ value: q._id, label: q.label }))
                                      ]}
                                    />

                                    {question.visibilityRule && (
                                      <>
                                        <CustomSelect
                                          value={question.visibilityRule.operator || 'equals'}
                                          onChange={(val) => handleImmediateQuestionUpdate(question._id, {
                                            visibilityRule: { ...question.visibilityRule, operator: val }
                                          })}
                                          options={[
                                            { value: 'equals', label: 'Equals' },
                                            { value: 'not_equals', label: 'Does not equal' },
                                            { value: 'contains', label: 'Contains' }
                                          ]}
                                        />
                                        <input
                                          type="text"
                                          placeholder="Value"
                                          value={question.visibilityRule.value || ''}
                                          onChange={(e) => handleDebouncedQuestionUpdate(question._id, {
                                            visibilityRule: { ...question.visibilityRule, value: e.target.value }
                                          })}
                                          onBlur={() => flushQuestionUpdate(question._id)}
                                          className="input px-2 py-1 text-black w-24 h-8 text-sm"
                                        />
                                      </>
                                    )}
                                  </div>
                                </div>

                                {/* Options for choice questions */}
                                {['single_choice', 'multiple_choice', 'checkbox', 'dropdown'].includes(question.type) && (
                                  <div className="mt-4 space-y-2">
                                    {(question.options || []).map((option, optIndex) => (
                                      <div key={optIndex} className="flex gap-2">
                                        <input
                                          type="text"
                                          value={option}
                                          onChange={(e) => {
                                            const newOptions = [...question.options];
                                            newOptions[optIndex] = e.target.value;
                                            handleDebouncedQuestionUpdate(question._id, { options: newOptions });
                                          }}
                                          onBlur={() => flushQuestionUpdate(question._id)}
                                          className="flex-1 px-3 py-1 rounded text-sm focus:outline-none theme-transition"
                                          placeholder={`Option ${optIndex + 1}`}
                                        />
                                        <button
                                          onClick={() => {
                                            const newOptions = question.options.filter((_, i) => i !== optIndex);
                                            handleImmediateQuestionUpdate(question._id, { options: newOptions });
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
                                        handleImmediateQuestionUpdate(question._id, { options: newOptions });
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
              </StrictModeDroppable>
            </DragDropContext>

            {/* Add Question Button */}
            <button
              onClick={() => handleAddQuestion()}
              className="w-full border-2 border-dashed border-gray-300 dark:border-border-default rounded-2xl p-6 hover:bg-gray-50 dark:hover:bg-surface-hover hover:border-gray-400 dark:hover:border-border-strong transition-all duration-200 mt-6 text-gray-600 dark:text-text-secondary font-medium flex items-center justify-center gap-2"
            >
              <FiPlus className="w-5 h-5" /> Add Question
            </button>

            {/* AI Suggest Modal */}
            {showAIModal && (
              <div className="glass-backdrop overflow-y-auto">
                <div className="glass-panel max-w-2xl my-8">
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
              <div className="glass-backdrop">
                <div className="glass-panel">
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
              <div className="glass-backdrop overflow-y-auto">
                <div className="glass-panel max-w-2xl my-8">
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
