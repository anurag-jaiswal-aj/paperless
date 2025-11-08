import { configureStore } from '@reduxjs/toolkit';
import authReducer from './authSlice';
import formReducer from './formSlice';
import themeReducer from './themeSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    forms: formReducer,
    theme: themeReducer
  }
});

export default store;
