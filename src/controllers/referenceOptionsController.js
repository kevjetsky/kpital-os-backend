import mongoose from "mongoose";
import { Entry } from "../models/Entry.js";
import { ReferenceOption } from "../models/ReferenceOption.js";
import {
  asyncHandler,
  parseMoneyInput,
  roundMoney,
  normalizeOptionName,
  normalizeAddressField,
  normalizeInstagramHandle,
  normalizePhoneKey,
  formatCustomerAddress,
  toProductServiceType,
  serializeReferenceOption,
  deriveCustomerName,
  findCustomerByContact
} from "../utils.js";
import { REFERENCE_OPTION_KINDS } from "../constants.js";

export const list = asyncHandler(async (req, res) => {
  const options = await ReferenceOption.find({ accountId: req.accountId })
    .sort({ kind: 1, name: 1 })
    .lean();
  const customers = [];
  const productServices = [];

  options.forEach((option) => {
    if (option.kind === "customer") {
      customers.push(serializeReferenceOption(option));
      return;
    }

    if (option.kind === "product_service") {
      productServices.push(serializeReferenceOption(option));
    }
  });

  res.json({ customers, productServices });
});

export const create = asyncHandler(async (req, res) => {
  const kind = String(req.body?.kind || "").trim();
  if (!REFERENCE_OPTION_KINDS.includes(kind)) {
    return res.status(400).json({ message: "Kind must be customer or product_service." });
  }

  let name = String(req.body?.name || "").trim();
  if (!name && kind !== "customer") {
    return res.status(400).json({ message: "Name is required." });
  }

  const payload = {
    accountId: req.accountId,
    kind,
    name,
    normalizedName: "",
    phone: "",
    phoneKey: "",
    instagram: "",
    instagramKey: "",
    email: "",
    address: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    reference: "",
    optionType: "",
    price: 0,
    cost: 0
  };

  if (kind === "customer") {
    const phone = String(req.body?.phone || "").trim();
    const instagram = normalizeInstagramHandle(req.body?.instagram);
    if (!phone && !instagram) {
      return res.status(400).json({ message: "A phone number or Instagram username is required." });
    }

    const duplicate = await findCustomerByContact(req.accountId, phone, instagram);
    if (duplicate) {
      return res.status(409).json({
        message: `A customer with this phone or Instagram already exists ("${duplicate.name}").`
      });
    }

    const email = String(req.body?.email || "").trim();
    const reference = String(req.body?.reference || "").trim();
    const addressLine1 = normalizeAddressField(req.body?.addressLine1);
    const addressLine2 = normalizeAddressField(req.body?.addressLine2);
    const city = normalizeAddressField(req.body?.city);
    const state = normalizeAddressField(req.body?.state);
    const postalCode = normalizeAddressField(req.body?.postalCode);
    const formattedAddress = formatCustomerAddress({ addressLine1, addressLine2, city, state, postalCode });
    const legacyAddress = String(req.body?.address || "").trim();

    const notes = String(req.body?.notes || "").trim();
    name = deriveCustomerName(name, phone, instagram);
    payload.name = name;
    payload.phone = phone;
    payload.phoneKey = normalizePhoneKey(phone);
    payload.instagram = instagram;
    payload.instagramKey = normalizeInstagramHandle(instagram);
    payload.email = email;
    payload.address = formattedAddress || legacyAddress;
    payload.addressLine1 = addressLine1;
    payload.addressLine2 = addressLine2;
    payload.city = city;
    payload.state = state;
    payload.postalCode = postalCode;
    payload.reference = reference;
    payload.notes = notes;
  }

  if (kind === "product_service") {
    const optionType = toProductServiceType(req.body?.optionType);
    if (!optionType) {
      return res.status(400).json({ message: "Product/service type must be product or service." });
    }

    const parsedPrice = parseMoneyInput(req.body?.price, "Price");
    if (parsedPrice.error) {
      return res.status(400).json({ message: parsedPrice.error });
    }
    const parsedCost = parseMoneyInput(req.body?.cost ?? 0, "Cost");
    if (parsedCost.error) {
      return res.status(400).json({ message: parsedCost.error });
    }

    payload.optionType = optionType;
    payload.price = parsedPrice.value;
    payload.cost = parsedCost.value;
  }

  payload.normalizedName = normalizeOptionName(payload.name);

  try {
    const created = await ReferenceOption.create(payload);
    return res.status(201).json(serializeReferenceOption(created));
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "Reference option already exists." });
    }
    throw error;
  }
});

export const update = asyncHandler(async (req, res) => {
  const optionId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(optionId)) {
    return res.status(400).json({ message: "Invalid reference option id." });
  }

  const existing = await ReferenceOption.findOne({ _id: optionId, accountId: req.accountId });
  if (!existing) {
    return res.status(404).json({ message: "Reference option not found." });
  }

  const hasOwn = (field) => Object.prototype.hasOwnProperty.call(req.body || {}, field);
  let name = hasOwn("name") ? String(req.body?.name || "").trim() : existing.name;
  if (!name && existing.kind !== "customer") {
    return res.status(400).json({ message: "Name is required." });
  }

  if (existing.kind === "customer") {
    const phone = hasOwn("phone") ? String(req.body?.phone || "").trim() : (existing.phone || "");
    const instagram = hasOwn("instagram")
      ? normalizeInstagramHandle(req.body?.instagram)
      : normalizeInstagramHandle(existing.instagram);
    if (!phone && !instagram) {
      return res.status(400).json({ message: "A phone number or Instagram username is required." });
    }

    const duplicate = await findCustomerByContact(req.accountId, phone, instagram, existing._id);
    if (duplicate) {
      return res.status(409).json({
        message: `A customer with this phone or Instagram already exists ("${duplicate.name}").`
      });
    }

    existing.phone = phone;
    existing.phoneKey = normalizePhoneKey(phone);
    existing.instagram = instagram;
    existing.instagramKey = normalizeInstagramHandle(instagram);
    name = deriveCustomerName(name, phone, instagram);

    const addressLine1 = hasOwn("addressLine1")
      ? normalizeAddressField(req.body?.addressLine1)
      : (existing.addressLine1 || "");
    const addressLine2 = hasOwn("addressLine2")
      ? normalizeAddressField(req.body?.addressLine2)
      : (existing.addressLine2 || "");
    const city = hasOwn("city") ? normalizeAddressField(req.body?.city) : (existing.city || "");
    const state = hasOwn("state") ? normalizeAddressField(req.body?.state) : (existing.state || "");
    const postalCode = hasOwn("postalCode")
      ? normalizeAddressField(req.body?.postalCode)
      : (existing.postalCode || "");
    const legacyAddress = hasOwn("address") ? String(req.body?.address || "").trim() : (existing.address || "");
    const formattedAddress = formatCustomerAddress({ addressLine1, addressLine2, city, state, postalCode });

    existing.email = hasOwn("email") ? String(req.body?.email || "").trim() : (existing.email || "");
    existing.reference = hasOwn("reference") ? String(req.body?.reference || "").trim() : (existing.reference || "");
    existing.notes = hasOwn("notes") ? String(req.body?.notes || "").trim() : (existing.notes || "");
    existing.addressLine1 = addressLine1;
    existing.addressLine2 = addressLine2;
    existing.city = city;
    existing.state = state;
    existing.postalCode = postalCode;
    existing.address = formattedAddress || legacyAddress;
  }

  existing.name = name;
  existing.normalizedName = normalizeOptionName(name);

  if (existing.kind === "product_service") {
    const nextType = hasOwn("optionType")
      ? toProductServiceType(req.body?.optionType)
      : toProductServiceType(existing.optionType);
    if (!nextType) {
      return res.status(400).json({ message: "Product/service type must be product or service." });
    }
    existing.optionType = nextType;

    if (hasOwn("price")) {
      const parsedPrice = parseMoneyInput(req.body?.price, "Price");
      if (parsedPrice.error) {
        return res.status(400).json({ message: parsedPrice.error });
      }
      existing.price = parsedPrice.value;
    } else {
      existing.price = roundMoney(existing.price || 0);
    }

    if (hasOwn("cost")) {
      const parsedCost = parseMoneyInput(req.body?.cost, "Cost");
      if (parsedCost.error) {
        return res.status(400).json({ message: parsedCost.error });
      }
      existing.cost = parsedCost.value;
    } else {
      existing.cost = roundMoney(existing.cost || 0);
    }
  }

  try {
    await existing.save();
    return res.json(serializeReferenceOption(existing));
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "Reference option already exists." });
    }
    throw error;
  }
});

export const remove = asyncHandler(async (req, res) => {
  const optionId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(optionId)) {
    return res.status(400).json({ message: "Invalid reference option id." });
  }

  const deleted = await ReferenceOption.findOneAndDelete({ _id: optionId, accountId: req.accountId });
  if (!deleted) {
    return res.status(404).json({ message: "Reference option not found." });
  }

  if (deleted.kind === "customer") {
    await Entry.updateMany(
      { accountId: req.accountId, customerOptionId: deleted._id },
      { $set: { customerOptionId: null } }
    );
  }

  if (deleted.kind === "product_service") {
    await Entry.updateMany(
      { accountId: req.accountId, productServiceOptionId: deleted._id },
      { $set: { productServiceOptionId: null } }
    );
  }

  return res.json({ ok: true });
});
