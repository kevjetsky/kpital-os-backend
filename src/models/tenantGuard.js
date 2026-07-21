import mongoose from "mongoose";

// Defense in depth for multi-tenancy.
//
// The failure mode this exists to prevent is silent: mongoose strips undefined
// values from filters, so a query that forgets accountId — or passes an
// undefined one — becomes an unscoped query that returns or mutates EVERY
// account's documents. Nothing throws, nothing logs, and the bug only surfaces
// as one business seeing another's financial records.
//
// This plugin turns that silent leak into a loud error: any read/write on a
// tenant-scoped model must name accountId in its filter. Deliberately-global
// queries (the cron sweep, migrations, the account-provisioning path) opt out
// explicitly via .setOptions({ allowCrossAccount: true }).

const GUARDED_OPS = [
  "count",
  "countDocuments",
  "deleteMany",
  "deleteOne",
  "find",
  "findOne",
  "findOneAndDelete",
  "findOneAndReplace",
  "findOneAndUpdate",
  "replaceOne",
  "updateMany",
  "updateOne",
];

function hasAccountId(filter) {
  if (!filter || typeof filter !== "object") return false;
  if (filter.accountId !== undefined && filter.accountId !== null) return true;
  // Accept an accountId nested inside a top-level $and/$or branch.
  for (const key of ["$and", "$or"]) {
    const branches = filter[key];
    if (Array.isArray(branches) && branches.length > 0 && branches.every(hasAccountId)) {
      return true;
    }
  }
  return false;
}

export function tenantGuard(schema, { modelName = "model" } = {}) {
  schema.pre(GUARDED_OPS, function guardQuery() {
    if (this.getOptions?.().allowCrossAccount) return;
    if (hasAccountId(this.getFilter())) return;

    throw new Error(
      `Unscoped ${modelName} query: every ${modelName} query must filter on accountId. ` +
        "Pass accountId, or opt out with .setOptions({ allowCrossAccount: true }) if the " +
        "query is intentionally cross-account."
    );
  });

  schema.pre("aggregate", function guardAggregate() {
    if (this.options?.allowCrossAccount) return;
    const first = this.pipeline()[0];
    if (first && first.$match && hasAccountId(first.$match)) return;

    throw new Error(
      `Unscoped ${modelName} aggregation: the pipeline must start with a $match on accountId ` +
        "(wrap the id with toAccountObjectId — aggregate does not cast strings), or pass " +
        "{ allowCrossAccount: true } as an aggregate option."
    );
  });

  // Guards the write path too: save() bypasses query middleware entirely, so a
  // document created without accountId would otherwise land unscoped and be
  // invisible to every scoped read.
  schema.pre("validate", function guardDocument(next) {
    if (!this.accountId) {
      return next(new Error(`${modelName} requires an accountId.`));
    }
    return next();
  });
}

// Convenience for models that only need the defaults.
export function applyTenantGuard(schema, modelName) {
  tenantGuard(schema, { modelName });
  schema.add({
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  });
}
