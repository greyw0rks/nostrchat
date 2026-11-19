import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const jobs = cronJobs();
jobs.interval('Expire authentication and rate metadata', { hours: 1 }, internal.model.cleanup, {});
jobs.interval('Expire short-lived chat payment reviews', { minutes: 15 }, internal.chatModel.cleanupReviews, {});
export default jobs;
