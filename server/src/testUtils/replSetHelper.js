import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import User from '../models/user.js';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import DeletionCleanupJob from '../models/deletionCleanupJob.js';
import InstanceLease, { InstanceLeaseSlot } from '../models/instanceLease.js';

const CORE_MODELS = [
  User,
  Form,
  Question,
  Response,
  SubmissionReservation,
  DeletionCleanupJob,
  InstanceLease,
  InstanceLeaseSlot
];

/**
 * Starts a single-node MongoDB replica set via MongoMemoryReplSet, connects Mongoose,
 * and pre-creates collections and indexes for all core (and optional extra) models
 * so multi-document transactions never fail with Error 112 on implicit collection creation.
 *
 * @param {Array<import('mongoose').Model>} [extraModels=[]]
 * @returns {Promise<MongoMemoryReplSet>}
 */
export const startReplSet = async (extraModels = []) => {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  await mongoose.connect(replSet.getUri());

  const modelsToPrepare = [...CORE_MODELS, ...extraModels];
  const seen = new Set();
  for (const Model of modelsToPrepare) {
    if (!Model || seen.has(Model.modelName)) continue;
    seen.add(Model.modelName);
    await Model.createCollection();
    await Model.createIndexes();
  }

  return replSet;
};

/**
 * Disconnects Mongoose and stops the MongoMemoryReplSet instance cleanly.
 *
 * @param {MongoMemoryReplSet|null} replSet
 */
export const stopReplSet = async (replSet) => {
  await mongoose.disconnect();
  if (replSet) {
    await replSet.stop();
  }
};
