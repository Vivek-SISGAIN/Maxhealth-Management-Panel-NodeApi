import { Router, type IRouter } from "express";
import healthRouter from "./health";
import managementRouter from "./management";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/management", managementRouter);

export default router;
