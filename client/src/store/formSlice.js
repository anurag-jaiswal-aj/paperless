import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  forms: [],
  currentForm: null,
  questions: [],
  loading: false,
  error: null
};

const formSlice = createSlice({
  name: 'forms',
  initialState,
  reducers: {
    setLoading: (state, action) => {
      state.loading = action.payload;
    },
    setError: (state, action) => {
      state.error = action.payload;
      state.loading = false;
    },
    clearError: (state) => {
      state.error = null;
    },
    setForms: (state, action) => {
      state.forms = action.payload;
      state.loading = false;
    },
    setCurrentForm: (state, action) => {
      state.currentForm = action.payload;
      state.loading = false;
    },
    setQuestions: (state, action) => {
      state.questions = action.payload;
      state.loading = false;
    },
    addForm: (state, action) => {
      state.forms.unshift(action.payload);
    },
    updateFormInList: (state, action) => {
      const index = state.forms.findIndex(f => f._id === action.payload._id);
      if (index !== -1) {
        state.forms[index] = action.payload;
      }
    },
    removeForm: (state, action) => {
      state.forms = state.forms.filter(f => f._id !== action.payload);
    },
    addQuestion: (state, action) => {
      state.questions.push(action.payload);
    },
    updateQuestion: (state, action) => {
      const index = state.questions.findIndex(q => q._id === action.payload._id);
      if (index !== -1) {
        state.questions[index] = action.payload;
      }
    },
    removeQuestion: (state, action) => {
      state.questions = state.questions.filter(q => q._id !== action.payload);
    },
    reorderQuestions: (state, action) => {
      state.questions = action.payload;
    }
  }
});

export const {
  setLoading,
  setError,
  clearError,
  setForms,
  setCurrentForm,
  setQuestions,
  addForm,
  updateFormInList,
  removeForm,
  addQuestion,
  updateQuestion,
  removeQuestion,
  reorderQuestions
} = formSlice.actions;

export default formSlice.reducer;
