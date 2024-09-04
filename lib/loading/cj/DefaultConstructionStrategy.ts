import { ConstructionStrategyCommonJs } from "../../construction/strategy/ConstructionStrategyCommonJs.js";

export const constructionStrategy = () => new ConstructionStrategyCommonJs({ req: require });
