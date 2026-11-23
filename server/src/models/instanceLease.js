import mongoose from 'mongoose';

export const INSTANCE_LEASE_SINGLETON_ID = 'app_server_instance';
export const INSTANCE_LEASE_SLOT_COUNT = 16;
export const ALL_16_SLOT_IDS = Object.freeze(
  Array.from({ length: INSTANCE_LEASE_SLOT_COUNT }, (_, i) => `slot_${i}`)
);

export const INSTANCE_LEASE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED'
});

const instanceLeaseSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: INSTANCE_LEASE_SINGLETON_ID
    },
    instanceId: {
      type: String,
      required: true
    },
    hostname: {
      type: String,
      default: null
    },
    pid: {
      type: Number,
      default: null
    },
    status: {
      type: String,
      enum: Object.values(INSTANCE_LEASE_STATUS),
      default: INSTANCE_LEASE_STATUS.ACTIVE,
      required: true
    },
    startedAt: {
      type: Date,
      default: Date.now,
      required: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    lastHeartbeatAt: {
      type: Date,
      default: Date.now,
      required: true
    },
    leaseTtlMs: {
      type: Number,
      default: 30000,
      required: true
    },
    heartbeatIntervalMs: {
      type: Number,
      default: 10000,
      required: true
    },
    lastActivityAt: {
      type: Date,
      default: null
    },
    txEpoch: {
      type: Number,
      default: 0
    },
    version: {
      type: Number,
      default: 0
    }
  },
  {
    collection: 'app_instance_leases',
    timestamps: true
  }
);

instanceLeaseSchema.index({ expiresAt: 1 });

const InstanceLease =
  mongoose.models.InstanceLease || mongoose.model('InstanceLease', instanceLeaseSchema);

const instanceLeaseSlotSchema = new mongoose.Schema(
  {
    _id: {
      type: String, // 'slot_0' through 'slot_15'
      required: true
    },
    slotIndex: {
      type: Number,
      required: true,
      index: true
    },
    instanceId: {
      type: String,
      default: null
    },
    version: {
      type: Number,
      default: 0
    },
    fenceEpoch: {
      type: Number,
      default: 0,
      required: true
    },
    status: {
      type: String,
      enum: Object.values(INSTANCE_LEASE_STATUS),
      default: INSTANCE_LEASE_STATUS.RELEASED,
      required: true
    },
    expiresAt: {
      type: Date,
      default: () => new Date(0),
      required: true
    },
    lastTouchAt: {
      type: Date,
      default: null
    }
  },
  {
    collection: 'app_instance_lease_slots',
    timestamps: true
  }
);

instanceLeaseSlotSchema.index({ instanceId: 1, status: 1, expiresAt: 1 });

export const InstanceLeaseSlot =
  mongoose.models.InstanceLeaseSlot || mongoose.model('InstanceLeaseSlot', instanceLeaseSlotSchema);

export default InstanceLease;
