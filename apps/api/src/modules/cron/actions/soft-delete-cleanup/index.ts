import { defineAction } from "../registry";
import { execute } from "./executor";
import { spec } from "./spec";

export default defineAction({ spec, execute });
