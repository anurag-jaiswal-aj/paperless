import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/user.js';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import responseRoutes from '../routes/responseRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';

// Setup Express App for End-to-End Testing
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/responses', responseRoutes);
app.use(errorHandler);

// Helper to generate JWT auth token
const generateToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET || 'testsecret', { expiresIn: '15m' });
};

// ============================================================================
// REFERENCE BASELINE PIPELINE (ORIGINAL IMPLEMENTATION BEFORE PERF-03)
// ============================================================================
export const executeBaselinePipeline = async (form, query = {}) => {
  const { startDate, endDate } = query;
  const matchCriteria = { formId: form._id };

  if (startDate || endDate) {
    matchCriteria.createdAt = {};
    if (startDate) {
      const start = new Date(startDate);
      if (!isNaN(start.getTime())) matchCriteria.createdAt.$gte = start;
    }
    if (endDate) {
      const end = new Date(endDate);
      if (!isNaN(end.getTime())) matchCriteria.createdAt.$lte = end;
    }
    if (Object.keys(matchCriteria.createdAt).length === 0) {
      delete matchCriteria.createdAt;
    }
  }

  const [totalResponses, completedResponses, timeline, questions] = await Promise.all([
    Response.countDocuments(matchCriteria),
    Response.countDocuments({
      ...matchCriteria,
      'answers.0': { $exists: true }
    }),
    Response.aggregate([
      { $match: matchCriteria },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    Question.find({ formId: form._id }).sort({ order: 1 })
  ]);

  const completionRate =
    totalResponses > 0 ? Math.round((completedResponses / totalResponses) * 100) : 0;
  const choiceTypes = ['single_choice', 'multiple_choice', 'checkbox', 'dropdown'];
  const choiceQuestionIds = questions.filter((q) => choiceTypes.includes(q.type)).map((q) => q._id);
  const numberQuestionIds = questions.filter((q) => q.type === 'number').map((q) => q._id);
  const ratingQuestionIds = questions.filter((q) => q.type === 'rating').map((q) => q._id);

  const [totalAnswersAgg, choiceAgg, numberAgg, ratingAgg] = await Promise.all([
    Response.aggregate([
      { $match: matchCriteria },
      { $unwind: '$answers' },
      {
        $match: {
          'answers.questionId': { $ne: null },
          'answers.value': { $exists: true, $ne: null },
          $expr: {
            $and: [
              { $ne: ['$answers.value', ''] },
              { $ne: ['$answers.value', []] },
              {
                $cond: {
                  if: { $eq: [{ $type: '$answers.value' }, 'string'] },
                  then: { $gt: [{ $strLenCP: { $trim: { input: '$answers.value' } } }, 0] },
                  else: true
                }
              }
            ]
          }
        }
      },
      { $group: { _id: '$answers.questionId', totalAnswers: { $sum: 1 } } }
    ]),
    choiceQuestionIds.length > 0
      ? Response.aggregate([
          { $match: { ...matchCriteria, 'answers.questionId': { $in: choiceQuestionIds } } },
          { $unwind: '$answers' },
          {
            $match: {
              'answers.questionId': { $in: choiceQuestionIds },
              'answers.value': { $exists: true, $ne: null }
            }
          },
          {
            $project: {
              questionId: '$answers.questionId',
              value: {
                $cond: {
                  if: { $isArray: '$answers.value' },
                  then: '$answers.value',
                  else: ['$answers.value']
                }
              }
            }
          },
          { $unwind: '$value' },
          {
            $match: {
              $expr: {
                $and: [
                  { $in: [{ $type: '$value' }, ['string', 'int', 'long', 'double', 'decimal']] },
                  { $ne: [{ $trim: { input: { $toString: '$value' } } }, ''] }
                ]
              }
            }
          },
          {
            $group: {
              _id: {
                questionId: '$questionId',
                option: { $trim: { input: { $toString: '$value' } } }
              },
              count: { $sum: 1 }
            }
          },
          {
            $group: {
              _id: '$_id.questionId',
              totalSelections: { $sum: '$count' },
              totalCategories: { $sum: 1 },
              topOptions: {
                $topN: {
                  n: 20,
                  sortBy: { count: -1, '_id.option': 1 },
                  output: { option: '$_id.option', count: '$count' }
                }
              }
            }
          }
        ])
      : [],
    numberQuestionIds.length > 0
      ? Response.aggregate([
          { $match: { ...matchCriteria, 'answers.questionId': { $in: numberQuestionIds } } },
          { $unwind: '$answers' },
          {
            $match: {
              'answers.questionId': { $in: numberQuestionIds },
              'answers.value': { $exists: true, $ne: null }
            }
          },
          {
            $project: {
              questionId: '$answers.questionId',
              numVal: {
                $convert: { input: '$answers.value', to: 'double', onError: null, onNull: null }
              },
              rawVal: '$answers.value'
            }
          },
          {
            $match: {
              numVal: { $ne: null },
              $expr: { $and: [{ $ne: ['$rawVal', ''] }, { $ne: [{ $type: '$rawVal' }, 'bool'] }] }
            }
          },
          {
            $group: {
              _id: '$questionId',
              min: { $min: '$numVal' },
              max: { $max: '$numVal' },
              sum: { $sum: '$numVal' },
              count: { $sum: 1 }
            }
          }
        ])
      : [],
    ratingQuestionIds.length > 0
      ? Response.aggregate([
          { $match: { ...matchCriteria, 'answers.questionId': { $in: ratingQuestionIds } } },
          { $unwind: '$answers' },
          {
            $match: {
              'answers.questionId': { $in: ratingQuestionIds },
              'answers.value': { $exists: true, $ne: null }
            }
          },
          {
            $project: {
              questionId: '$answers.questionId',
              ratingVal: {
                $convert: { input: '$answers.value', to: 'int', onError: null, onNull: null }
              },
              rawVal: '$answers.value'
            }
          },
          {
            $match: {
              ratingVal: { $gte: 1, $lte: 5 },
              $expr: { $and: [{ $ne: ['$rawVal', ''] }, { $ne: [{ $type: '$rawVal' }, 'bool'] }] }
            }
          },
          {
            $group: {
              _id: { questionId: '$questionId', rating: '$ratingVal' },
              count: { $sum: 1 }
            }
          }
        ])
      : []
  ]);

  return formatAnalytics({
    totalResponses,
    completedResponses,
    completionRate,
    timeline,
    questions,
    choiceTypes,
    totalAnswersAgg,
    choiceAgg,
    numberAgg,
    ratingAgg
  });
};

function formatAnalytics({
  totalResponses,
  completedResponses,
  completionRate,
  timeline,
  questions,
  choiceTypes,
  totalAnswersAgg,
  choiceAgg,
  numberAgg,
  ratingAgg
}) {
  const totalAnswersMap = Object.create(null);
  for (const item of totalAnswersAgg) {
    if (item && item._id != null) totalAnswersMap[item._id.toString()] = item.totalAnswers;
  }

  const choiceStatsMap = Object.create(null);
  for (const item of choiceAgg) {
    if (item && item._id != null) choiceStatsMap[item._id.toString()] = item;
  }

  const numberStatsMap = Object.create(null);
  for (const item of numberAgg) {
    if (item && item._id != null) numberStatsMap[item._id.toString()] = item;
  }

  const ratingDistMap = Object.create(null);
  for (const item of ratingAgg) {
    if (item && item._id?.questionId != null) {
      const qIdStr = item._id.questionId.toString();
      if (!ratingDistMap[qIdStr]) ratingDistMap[qIdStr] = Object.create(null);
      ratingDistMap[qIdStr][item._id.rating] = item.count;
    }
  }

  const analytics = questions.map((question) => {
    const qIdStr = question._id.toString();
    const totalAnswers = totalAnswersMap[qIdStr] || 0;
    const { type } = question;
    let data = {};

    if (choiceTypes.includes(type)) {
      const stats = choiceStatsMap[qIdStr];
      const totalSelections = stats?.totalSelections || 0;
      const totalCategories = stats?.totalCategories || 0;
      const topOptions = stats?.topOptions || [];
      const optionsList = Array.isArray(question.options) ? question.options : [];
      const TOP_CATEGORIES_LIMIT = 20;

      let distribution = [];
      let otherCount = 0;
      let isTruncated = false;

      if (totalCategories <= TOP_CATEGORIES_LIMIT) {
        const optionCounts = Object.create(null);
        for (const item of topOptions) optionCounts[item.option] = item.count;
        const allOptionsMap = new Map();
        for (const opt of optionsList) allOptionsMap.set(opt, optionCounts[opt] || 0);
        for (const item of topOptions) {
          if (!allOptionsMap.has(item.option)) allOptionsMap.set(item.option, item.count);
        }

        distribution = Array.from(allOptionsMap.entries()).map(([opt, count]) => ({
          option: opt,
          count,
          percentage: totalAnswers > 0 ? Math.round((count / totalAnswers) * 100) : 0
        }));
      } else {
        isTruncated = true;
        const topEntries = topOptions.slice(0, TOP_CATEGORIES_LIMIT - 1);
        let topCountsSum = 0;
        for (const item of topEntries) topCountsSum += item.count;
        otherCount = Math.max(0, totalSelections - topCountsSum);

        distribution = topEntries.map((item) => ({
          option: item.option,
          count: item.count,
          percentage: totalAnswers > 0 ? Math.round((item.count / totalAnswers) * 100) : 0
        }));

        if (otherCount > 0) {
          distribution.push({
            option: 'Other',
            count: otherCount,
            percentage: totalAnswers > 0 ? Math.round((otherCount / totalAnswers) * 100) : 0
          });
        }
      }

      data = {
        type: 'options',
        distribution,
        totalSelections,
        isTruncated,
        displayedCategories: distribution.length,
        totalCategories: isTruncated ? totalCategories : distribution.length,
        otherCount
      };
    } else if (type === 'number') {
      const numStats = numberStatsMap[qIdStr];
      if (numStats && numStats.count > 0) {
        data = {
          type: 'number',
          min: numStats.min,
          max: numStats.max,
          average: Number((numStats.sum / numStats.count).toFixed(2))
        };
      } else {
        data = { type: 'number', min: null, max: null, average: null };
      }
    } else if (type === 'rating') {
      const ratingCounts = ratingDistMap[qIdStr] || Object.create(null);
      const distribution = {
        1: ratingCounts[1] || 0,
        2: ratingCounts[2] || 0,
        3: ratingCounts[3] || 0,
        4: ratingCounts[4] || 0,
        5: ratingCounts[5] || 0
      };
      let sum = 0;
      let totalRatings = 0;
      for (let r = 1; r <= 5; r++) {
        const c = distribution[r];
        sum += r * c;
        totalRatings += c;
      }
      const average = totalRatings > 0 ? Number((sum / totalRatings).toFixed(1)) : 0;
      data = { type: 'rating', average, distribution, totalRatings };
    } else if (type === 'file') {
      data = { type: 'file', count: totalAnswers };
    } else {
      data = { type: 'text', count: totalAnswers };
    }

    return {
      questionId: question._id.toString(),
      label: question.label,
      type: question.type,
      totalAnswers,
      data
    };
  });

  return {
    totalResponses,
    summary: {
      totalResponses,
      completedResponses,
      completionRate
    },
    timeline: timeline.map((t) => ({ date: t._id, count: t.count })),
    analytics
  };
}

describe('PERF-03: Analytics Pipeline Optimization - 14-Scenario Semantic Equivalence Suite', () => {
  let replSet;
  let owner;
  let ownerToken;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'testsecret';
    replSet = await startReplSet();
  });

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await Form.deleteMany({});
    await Question.deleteMany({});
    await Response.deleteMany({});

    owner = await User.create({
      name: 'Analytics Tester',
      email: `analytics_test_${Date.now()}@example.com`,
      password: 'password123'
    });
    ownerToken = generateToken(owner._id);
  });

  const assertPipelineEquivalence = async (form, query = {}) => {
    const baseline = await executeBaselinePipeline(form, query);

    let queryString = '';
    if (Object.keys(query).length > 0) {
      queryString = '?' + new URLSearchParams(query).toString();
    }
    const res = await request(app)
      .get(`/api/responses/${form._id}/analytics${queryString}`)
      .set('Cookie', [`token=${ownerToken}`]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(baseline);

    return baseline;
  };

  // Scenario 1: Missing answers
  it('Scenario 1: Missing answers - handles omitted answers property without throwing', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S1', status: 'published' });
    await Question.create({ formId: form._id, type: 'short_text', label: 'Name', order: 0 });

    await Response.collection.insertOne({
      formId: form._id,
      submittedBy: 'anonymous',
      createdAt: new Date('2026-03-01T10:00:00.000Z')
    });

    const res = await assertPipelineEquivalence(form);
    expect(res.totalResponses).toBe(1);
    expect(res.summary.completedResponses).toBe(0);
    expect(res.summary.completionRate).toBe(0);
    expect(res.analytics[0].totalAnswers).toBe(0);
  });

  // Scenario 2: answers: null
  it('Scenario 2: answers: null - handles explicit null answers gracefully', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S2', status: 'published' });
    await Question.create({ formId: form._id, type: 'number', label: 'Score', order: 0 });

    await Response.collection.insertOne({
      formId: form._id,
      answers: null,
      submittedBy: 'anonymous',
      createdAt: new Date('2026-03-01T10:00:00.000Z')
    });

    const res = await assertPipelineEquivalence(form);
    expect(res.totalResponses).toBe(1);
    expect(res.summary.completedResponses).toBe(0);
    expect(res.analytics[0].totalAnswers).toBe(0);
    expect(res.analytics[0].data).toEqual({ type: 'number', min: null, max: null, average: null });
  });

  // Scenario 3: Empty answers array
  it('Scenario 3: Empty answers array - answers: [] does not count toward completedResponses', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S3', status: 'published' });
    await Question.create({ formId: form._id, type: 'rating', label: 'Stars', order: 0 });

    await Response.create({
      formId: form._id,
      answers: [],
      createdAt: new Date('2026-03-01T10:00:00.000Z')
    });

    const res = await assertPipelineEquivalence(form);
    expect(res.totalResponses).toBe(1);
    expect(res.summary.completedResponses).toBe(0);
    expect(res.analytics[0].totalAnswers).toBe(0);
    expect(res.analytics[0].data.totalRatings).toBe(0);
  });

  // Scenario 4: Non-empty array with no matching answers
  it('Scenario 4: Non-empty array with no matching answers - completed response with 0 form answers', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S4', status: 'published' });
    await Question.create({
      formId: form._id,
      type: 'single_choice',
      label: 'Choice',
      options: ['Red', 'Blue'],
      order: 0
    });
    const foreignQuestionId = new mongoose.Types.ObjectId();

    await Response.create({
      formId: form._id,
      answers: [{ questionId: foreignQuestionId, value: 'Foreign Answer' }],
      createdAt: new Date('2026-03-01T10:00:00.000Z')
    });

    const res = await assertPipelineEquivalence(form);
    expect(res.totalResponses).toBe(1);
    expect(res.summary.completedResponses).toBe(1);
    expect(res.analytics[0].totalAnswers).toBe(0);
    expect(res.analytics[0].data.totalSelections).toBe(0);
  });

  // Scenario 5: One matching answer
  it('Scenario 5: One matching answer - computes matching question while preserving uncompleted questions', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S5', status: 'published' });
    const q1 = await Question.create({
      formId: form._id,
      type: 'single_choice',
      label: 'Fruit',
      options: ['Apple', 'Banana'],
      order: 0
    });
    await Question.create({ formId: form._id, type: 'number', label: 'Quantity', order: 1 });
    await Question.create({ formId: form._id, type: 'rating', label: 'Satisfaction', order: 2 });

    await Response.create({
      formId: form._id,
      answers: [{ questionId: q1._id, value: 'Apple' }],
      createdAt: new Date('2026-03-01T10:00:00.000Z')
    });

    const res = await assertPipelineEquivalence(form);
    expect(res.summary.completedResponses).toBe(1);
    expect(res.analytics[0].totalAnswers).toBe(1);
    expect(res.analytics[0].data.distribution.find((d) => d.option === 'Apple').count).toBe(1);
    expect(res.analytics[1].totalAnswers).toBe(0);
    expect(res.analytics[1].data.min).toBeNull();
    expect(res.analytics[2].totalAnswers).toBe(0);
    expect(res.analytics[2].data.totalRatings).toBe(0);
  });

  // Scenario 6: Multiple matching answers
  it('Scenario 6: Multiple matching answers - correctly aggregates multi-field submissions in single response', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S6', status: 'published' });
    const qText = await Question.create({ formId: form._id, type: 'short_text', label: 'Feedback', order: 0 });
    const qChoice = await Question.create({
      formId: form._id,
      type: 'single_choice',
      label: 'Tier',
      options: ['Pro', 'Free'],
      order: 1
    });
    const qNum = await Question.create({ formId: form._id, type: 'number', label: 'NPS', order: 2 });
    const qRate = await Question.create({ formId: form._id, type: 'rating', label: 'Stars', order: 3 });

    await Response.create({
      formId: form._id,
      answers: [
        { questionId: qText._id, value: 'Great service' },
        { questionId: qChoice._id, value: 'Pro' },
        { questionId: qNum._id, value: 95 },
        { questionId: qRate._id, value: 5 }
      ],
      createdAt: new Date('2026-03-01T10:00:00.000Z')
    });

    const res = await assertPipelineEquivalence(form);
    expect(res.analytics[0].totalAnswers).toBe(1);
    expect(res.analytics[1].data.distribution.find((d) => d.option === 'Pro').count).toBe(1);
    expect(res.analytics[2].data).toEqual({ type: 'number', min: 95, max: 95, average: 95 });
    expect(res.analytics[3].data.distribution['5']).toBe(1);
    expect(res.analytics[3].data.average).toBe(5);
  });

  // Scenario 7: Duplicate answers
  it('Scenario 7: Duplicate answers - maintains unwind semantics when same question is answered repeatedly', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S7', status: 'published' });
    const qChoice = await Question.create({
      formId: form._id,
      type: 'single_choice',
      label: 'Tag',
      options: ['Urgent', 'Normal'],
      order: 0
    });
    const qNum = await Question.create({ formId: form._id, type: 'number', label: 'Score', order: 1 });

    await Response.create({
      formId: form._id,
      answers: [
        { questionId: qChoice._id, value: 'Urgent' },
        { questionId: qChoice._id, value: 'Urgent' },
        { questionId: qNum._id, value: 10 },
        { questionId: qNum._id, value: 30 }
      ],
      createdAt: new Date('2026-03-01T10:00:00.000Z')
    });

    const res = await assertPipelineEquivalence(form);
    expect(res.analytics[0].totalAnswers).toBe(2);
    expect(res.analytics[0].data.totalSelections).toBe(2);
    expect(res.analytics[0].data.distribution.find((d) => d.option === 'Urgent').count).toBe(2);
    expect(res.analytics[1].totalAnswers).toBe(2);
    expect(res.analytics[1].data).toEqual({ type: 'number', min: 10, max: 30, average: 20 });
  });

  // Scenario 8: Conditional questions
  it('Scenario 8: Conditional questions - computes counts for conditional questions answered only by qualifying users', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S8', status: 'published' });
    const qLead = await Question.create({
      formId: form._id,
      type: 'single_choice',
      label: 'Has Vehicle?',
      options: ['Yes', 'No'],
      order: 0
    });
    const qDep = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Model',
      visibilityRule: { targetQuestionId: qLead._id, operator: 'equals', value: 'Yes' },
      order: 1
    });

    await Response.create([
      {
        formId: form._id,
        answers: [
          { questionId: qLead._id, value: 'Yes' },
          { questionId: qDep._id, value: 'Sedan' }
        ],
        createdAt: new Date('2026-03-01T10:00:00.000Z')
      },
      {
        formId: form._id,
        answers: [{ questionId: qLead._id, value: 'No' }],
        createdAt: new Date('2026-03-01T11:00:00.000Z')
      }
    ]);

    const res = await assertPipelineEquivalence(form);
    expect(res.summary.totalResponses).toBe(2);
    expect(res.analytics[0].totalAnswers).toBe(2);
    expect(res.analytics[1].totalAnswers).toBe(1);
    expect(res.analytics[1].data.count).toBe(1);
  });

  // Scenario 9: Hidden questions
  it('Scenario 9: Hidden questions - preserves hidden questions in analytics array with 0 totalAnswers', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S9', status: 'published' });
    const qMain = await Question.create({ formId: form._id, type: 'short_text', label: 'Comment', order: 0 });
    const qHidden = await Question.create({
      formId: form._id,
      type: 'rating',
      label: 'Admin Evaluation',
      visibilityRule: { targetQuestionId: qMain._id, operator: 'equals', value: '__NEVER_TRIGGERED__' },
      order: 1
    });

    await Response.create([
      { formId: form._id, answers: [{ questionId: qMain._id, value: 'Normal 1' }], createdAt: new Date() },
      { formId: form._id, answers: [{ questionId: qMain._id, value: 'Normal 2' }], createdAt: new Date() }
    ]);

    const res = await assertPipelineEquivalence(form);
    expect(res.analytics.length).toBe(2);
    expect(res.analytics[1].questionId).toBe(qHidden._id.toString());
    expect(res.analytics[1].totalAnswers).toBe(0);
    expect(res.analytics[1].data.totalRatings).toBe(0);
    expect(res.analytics[1].data.average).toBe(0);
  });

  // Scenario 10: Answers with missing or null values
  it('Scenario 10: Answers with missing or null values - strictly filters out corrupted/empty values', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S10', status: 'published' });
    const qText = await Question.create({ formId: form._id, type: 'short_text', label: 'Text Q', order: 0 });
    const qNum = await Question.create({ formId: form._id, type: 'number', label: 'Num Q', order: 1 });
    const qChoice = await Question.create({
      formId: form._id,
      type: 'single_choice',
      label: 'Choice Q',
      options: ['ValidOpt'],
      order: 2
    });
    const qRate = await Question.create({ formId: form._id, type: 'rating', label: 'Rate Q', order: 3 });

    await Response.collection.insertMany([
      {
        formId: form._id,
        answers: [
          { questionId: qText._id, value: '   ' }, // Whitespace ignored
          { questionId: qNum._id, value: null }, // Null ignored
          { questionId: qChoice._id, value: '' }, // Empty string ignored
          { questionId: qRate._id, value: 0 } // Out of range 0 ignored
        ],
        createdAt: new Date()
      },
      {
        formId: form._id,
        answers: [
          { questionId: qText._id, value: '' }, // Empty ignored
          { questionId: qNum._id, value: 'not-a-number' }, // NaN ignored
          { questionId: qNum._id, value: false }, // Boolean ignored
          { questionId: qRate._id, value: 99 } // Out of range 99 ignored
        ],
        createdAt: new Date()
      },
      {
        formId: form._id,
        answers: [
          { questionId: qText._id, value: 'Real Text' },
          { questionId: qNum._id, value: 50 },
          { questionId: qChoice._id, value: 'ValidOpt' },
          { questionId: qRate._id, value: 4 }
        ],
        createdAt: new Date()
      }
    ]);

    const res = await assertPipelineEquivalence(form);
    expect(res.analytics[0].totalAnswers).toBe(1);
    expect(res.analytics[1].totalAnswers).toBe(3);
    expect(res.analytics[1].data).toEqual({ type: 'number', min: 50, max: 50, average: 50 });
    expect(res.analytics[2].totalAnswers).toBe(1);
    expect(res.analytics[2].data.distribution.find((d) => d.option === 'ValidOpt').count).toBe(1);
    expect(res.analytics[3].totalAnswers).toBe(3);
    expect(res.analytics[3].data.totalRatings).toBe(1);
    expect(res.analytics[3].data.distribution['4']).toBe(1);
  });

  // Scenario 11: Different question types
  it('Scenario 11: Different question types - aggregates choice, number, rating, file, and text types', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S11', status: 'published' });
    const qShort = await Question.create({ formId: form._id, type: 'short_text', label: 'Short', order: 0 });
    const qEmail = await Question.create({ formId: form._id, type: 'email', label: 'Email', order: 1 });
    const qFile = await Question.create({ formId: form._id, type: 'file', label: 'CV', order: 2 });
    const qCheck = await Question.create({
      formId: form._id,
      type: 'checkbox',
      label: 'Skills',
      options: ['JS', 'Python', 'Go'],
      order: 3
    });
    const qNum = await Question.create({ formId: form._id, type: 'number', label: 'Exp', order: 4 });
    const qRate = await Question.create({ formId: form._id, type: 'rating', label: 'Level', order: 5 });

    await Response.create([
      {
        formId: form._id,
        answers: [
          { questionId: qShort._id, value: 'Alice' },
          { questionId: qEmail._id, value: 'alice@example.com' },
          { questionId: qFile._id, value: { key: 's3/key1', originalName: 'cv.pdf' } },
          { questionId: qCheck._id, value: ['JS', 'Go'] },
          { questionId: qNum._id, value: 5 },
          { questionId: qRate._id, value: 4 }
        ],
        createdAt: new Date()
      },
      {
        formId: form._id,
        answers: [
          { questionId: qShort._id, value: 'Bob' },
          { questionId: qEmail._id, value: 'bob@example.com' },
          { questionId: qFile._id, value: { key: 's3/key2', originalName: 'resume.pdf' } },
          { questionId: qCheck._id, value: ['Python'] },
          { questionId: qNum._id, value: 10 },
          { questionId: qRate._id, value: 5 }
        ],
        createdAt: new Date()
      }
    ]);

    const res = await assertPipelineEquivalence(form);
    expect(res.analytics[0].data.type).toBe('text');
    expect(res.analytics[1].data.type).toBe('text');
    expect(res.analytics[2].data.type).toBe('file');
    expect(res.analytics[2].data.count).toBe(2);
    expect(res.analytics[3].data.type).toBe('options');
    expect(res.analytics[3].data.totalSelections).toBe(3);
    expect(res.analytics[4].data).toEqual({ type: 'number', min: 5, max: 10, average: 7.5 });
    expect(res.analytics[5].data.type).toBe('rating');
    expect(res.analytics[5].data.average).toBe(4.5);
  });

  // Scenario 12: Multiple responses belonging to the same form
  it('Scenario 12: Multiple responses belonging to the same form - aggregates across dates and responses', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S12', status: 'published' });
    const q1 = await Question.create({
      formId: form._id,
      type: 'dropdown',
      label: 'City',
      options: ['NYC', 'London'],
      order: 0
    });
    const q2 = await Question.create({ formId: form._id, type: 'number', label: 'Age', order: 1 });

    await Response.create([
      { formId: form._id, answers: [{ questionId: q1._id, value: 'NYC' }, { questionId: q2._id, value: 25 }], createdAt: new Date('2026-03-01T10:00:00.000Z') },
      { formId: form._id, answers: [{ questionId: q1._id, value: 'London' }, { questionId: q2._id, value: 35 }], createdAt: new Date('2026-03-02T10:00:00.000Z') },
      { formId: form._id, answers: [{ questionId: q1._id, value: 'NYC' }, { questionId: q2._id, value: 45 }], createdAt: new Date('2026-03-03T10:00:00.000Z') }
    ]);

    const res = await assertPipelineEquivalence(form);
    expect(res.totalResponses).toBe(3);
    expect(res.timeline.length).toBe(3);
    expect(res.analytics[0].totalAnswers).toBe(3);
    expect(res.analytics[1].data).toEqual({ type: 'number', min: 25, max: 45, average: 35 });
  });

  // Scenario 13: Responses excluded by existing date filters
  it('Scenario 13: Responses excluded by existing date filters - limits analytics to specified range', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S13', status: 'published' });
    const q1 = await Question.create({ formId: form._id, type: 'number', label: 'Metric', order: 0 });

    await Response.create([
      { formId: form._id, answers: [{ questionId: q1._id, value: 100 }], createdAt: new Date('2026-01-01T10:00:00.000Z') },
      { formId: form._id, answers: [{ questionId: q1._id, value: 200 }], createdAt: new Date('2026-02-01T10:00:00.000Z') },
      { formId: form._id, answers: [{ questionId: q1._id, value: 300 }], createdAt: new Date('2026-03-01T10:00:00.000Z') }
    ]);

    const res = await assertPipelineEquivalence(form, {
      startDate: '2026-01-15T00:00:00.000Z',
      endDate: '2026-02-15T00:00:00.000Z'
    });

    expect(res.totalResponses).toBe(1);
    expect(res.timeline).toEqual([{ date: '2026-02-01', count: 1 }]);
    expect(res.analytics[0].data).toEqual({ type: 'number', min: 200, max: 200, average: 200 });
  });

  // Scenario 14: Responses with mixed matching and non-matching answers
  it('Scenario 14: Responses with mixed matching and non-matching answers - preserves valid without throwing on corrupt entries', async () => {
    const form = await Form.create({ ownerId: owner._id, title: 'Form S14', status: 'published' });
    const qChoice = await Question.create({
      formId: form._id,
      type: 'single_choice',
      label: 'Plan',
      options: ['Basic', 'Premium'],
      order: 0
    });
    const qNum = await Question.create({ formId: form._id, type: 'number', label: 'Seats', order: 1 });
    const foreignId = new mongoose.Types.ObjectId();

    await Response.collection.insertOne({
      formId: form._id,
      submittedBy: 'anonymous',
      answers: [
        { questionId: qChoice._id, value: 'Basic' },
        { questionId: null, value: 'corrupted_null_qid' },
        { questionId: foreignId, value: 999 },
        { questionId: qNum._id, value: 45 },
        { questionId: qChoice._id, value: null }
      ],
      createdAt: new Date()
    });

    const res = await assertPipelineEquivalence(form);
    expect(res.totalResponses).toBe(1);
    expect(res.analytics[0].totalAnswers).toBe(1);
    expect(res.analytics[0].data.distribution.find((d) => d.option === 'Basic').count).toBe(1);
    expect(res.analytics[1].totalAnswers).toBe(1);
    expect(res.analytics[1].data).toEqual({ type: 'number', min: 45, max: 45, average: 45 });
  });
});
