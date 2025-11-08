import OpenAI from 'openai';
import Response from '../models/response.js';
import Question from '../models/question.js';

// Initialize OpenAI client only if API key is provided
let openai = null;

if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  console.log('✅ OpenAI service initialized');
} else {
  console.log('⚠️  OpenAI API key not found - AI features will be disabled');
}

/**
 * Generate form questions based on a topic using GPT
 * @param {string} topic - The topic for question generation
 * @returns {Array} - Array of suggested questions
 */
export const suggestQuestions = async (topic) => {
  if (!openai) {
    throw new Error('OpenAI API is not configured. Please add OPENAI_API_KEY to your environment variables.');
  }

  try {
    const prompt = `You are a form builder assistant. Generate 5-10 relevant, diverse form questions for the topic: "${topic}".

Include a mix of question types:
- Short text questions
- Multiple choice questions (provide 3-5 options)
- Long text questions
- Rating questions (1-5 scale)
- Date questions where applicable

Return ONLY a valid JSON array with this exact structure:
[
  {
    "type": "short_text",
    "label": "Question text here"
  },
  {
    "type": "multiple_choice",
    "label": "Question text here",
    "options": ["Option 1", "Option 2", "Option 3"]
  }
]

Valid types: short_text, long_text, multiple_choice, checkbox, dropdown, rating, date, file

Do not include any explanation, just the JSON array.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant that generates form questions in JSON format.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 1000
    });

    const content = completion.choices[0].message.content.trim();
    
    // Parse JSON response
    let questions;
    try {
      questions = JSON.parse(content);
    } catch (parseError) {
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        questions = JSON.parse(jsonMatch[1]);
      } else {
        throw new Error('Failed to parse AI response as JSON');
      }
    }

    return questions;
  } catch (error) {
    console.error('OpenAI suggestQuestions error:', error.message);
    throw new Error(`Failed to generate questions: ${error.message}`);
  }
};

/**
 * Improve the wording of a question using GPT
 * @param {string} question - The original question text
 * @returns {Array} - Array of 3 improved versions
 */
export const improveWording = async (question) => {
  if (!openai) {
    throw new Error('OpenAI API is not configured. Please add OPENAI_API_KEY to your environment variables.');
  }

  try {
    const prompt = `Improve the following form question and provide 3 better variations that are:
- Clear and concise
- Professional
- Easy to understand
- More engaging

Original question: "${question}"

Return ONLY a valid JSON array of 3 strings, nothing else:
["Improved question 1", "Improved question 2", "Improved question 3"]`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant that improves form question wording.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 300
    });

    const content = completion.choices[0].message.content.trim();
    
    // Parse JSON response
    let improvements;
    try {
      improvements = JSON.parse(content);
    } catch (parseError) {
      // Try to extract JSON from markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        improvements = JSON.parse(jsonMatch[1]);
      } else {
        throw new Error('Failed to parse AI response as JSON');
      }
    }

    return improvements;
  } catch (error) {
    console.error('OpenAI improveWording error:', error.message);
    throw new Error(`Failed to improve question: ${error.message}`);
  }
};

/**
 * Generate summary of form responses using GPT
 * @param {string} formId - The form ID
 * @param {number} limit - Max number of responses to analyze (default 50)
 * @returns {string} - Summary text
 */
export const summarizeResponses = async (formId, limit = 50) => {
  if (!openai) {
    throw new Error('OpenAI API is not configured. Please add OPENAI_API_KEY to your environment variables.');
  }

  try {
    // Fetch questions and responses
    const questions = await Question.find({ formId }).sort({ order: 1 });
    const responses = await Response.find({ formId })
      .sort({ createdAt: -1 })
      .limit(limit);

    if (responses.length === 0) {
      return 'No responses available to summarize.';
    }

    // Format data for GPT
    const formattedData = {
      totalResponses: responses.length,
      questions: questions.map(q => ({
        label: q.label,
        type: q.type
      })),
      sampleResponses: responses.slice(0, 10).map(r => {
        const answers = {};
        r.answers.forEach(answer => {
          const question = questions.find(q => q._id.toString() === answer.questionId.toString());
          if (question) {
            answers[question.label] = answer.value;
          }
        });
        return answers;
      })
    };

    const prompt = `Analyze the following form responses and provide a comprehensive summary with key insights, trends, and patterns.

Form data:
${JSON.stringify(formattedData, null, 2)}

Provide a summary that includes:
1. Overall response patterns
2. Common themes or trends
3. Notable insights
4. Any interesting findings

Keep the summary concise (3-5 paragraphs) and actionable.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a data analyst specializing in form response analysis.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 800
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('OpenAI summarizeResponses error:', error.message);
    throw new Error(`Failed to generate summary: ${error.message}`);
  }
};
