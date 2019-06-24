import _ from "lodash";
import Logger from "@reactioncommerce/logger";
import { inputSchema } from "../utils/defaults";
import getModifier from "../utils/getModifier";

const logCtx = { name: "simple-inventory", file: "updateSimpleInventoryBulk" };

// eslint-disable-next-line require-jsdoc
export default async function updateSimpleInventoryBulk(context, input) {
  const { appEvents, collections, userId } = context;
  const { SimpleInventory } = collections;

  // generate mongo operation object for each product input. Return null on any invalid input
  let bulkOperations = input.updates.map((update) => {
    let modifier = {};
    try {
      inputSchema.validate(update);
      modifier = getModifier(update);
    } catch (error) {
      Logger.error({ ...logCtx, error });
      return null;
    }

    if (!modifier.$set || !modifier.$setOnInsert) return null;
    const { productConfiguration, shopId } = update;

    return {
      updateOne: {
        filter: {
          "productConfiguration.productVariantId": productConfiguration.productVariantId,
          shopId
        },
        update: modifier,
        upsert: true
      }
    };
  });

  bulkOperations = bulkOperations.filter((op) => op !== null);
  let res;
  try {
    res = await SimpleInventory.bulkWrite(bulkOperations, { ordered: false });
  } catch (error) {
    Logger.error({ ...logCtx, error }, "One or more of the bulk update failed");
    res = error; // error object has details about failed & successful operations
  }

  const upsertedIds = res.result.upserted.map((each) => each._id);
  const failedOps = bulkOperations.filter((op) => {
    const match = res.result.writeErrors.find((erroredOp) => {
      const isFilterEqual = _.isEqual(op.updateOne.filter, erroredOp.op.q);
      const isUpdateEqual = _.isEqual(op.updateOne.update, erroredOp.op.u);
      return isFilterEqual && isUpdateEqual;
    });
    if (match) return true;
    return false;
  });

  // If we inserted, set the "reserved" quantity to what it should be. We could have
  // put this in the $setOnInsert but then we'd have to do the Orders lookup for
  // calculating reserved every time, even when only an update happens. It's better
  // to wait until here when we know whether we inserted.
  if (res.result.nUpserted > 0) {
    const upsertedDocsOpData = bulkOperations.filter((op) => upsertedIds.includes(op.updateOne.update.$setOnInsert._id));
    upsertedDocsOpData.forEach((operationData) => {
      const arg = {
        productConfiguration: {
          productId: operationData.updateOne.update.$setOnInsert["productConfiguration.productId"],
          productVariantId: operationData.updateOne.filter["productConfiguration.productVariantId"]
        },
        shopId: operationData.updateOne.filter.shopId
      };
      Logger.debug({ ...logCtx, arg }, "Calling recalculateReservedSimpleInventory");
      context.mutations.recalculateReservedSimpleInventory(context, arg);
    });
  }

  if (res.result.nModified > 0) {
    const modifiedDocsOpData = bulkOperations.filter((op) => !upsertedIds.includes(op.updateOne.update.$setOnInsert._id));
    const productConfigurations = modifiedDocsOpData.map((operationData) => ({
      productId: operationData.updateOne.update.$setOnInsert["productConfiguration.productId"],
      productVariantId: operationData.updateOne.filter["productConfiguration.productVariantId"]
    }));
    appEvents.emit("afterBulkInventoryUpdate", { productConfigurations, updatedBy: userId });
  }

  return { failedOps };
}
