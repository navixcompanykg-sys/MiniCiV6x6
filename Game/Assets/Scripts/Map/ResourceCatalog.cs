namespace Civa.Map
{
    public readonly struct ResourceDefinition
    {
        public readonly ResourceType Type;
        public readonly ResourceCategory Category;
        public readonly int TotalCount;

        /// <summary>True for resources that require sea access (only Coast/Island regions).</summary>
        public readonly bool RequiresSeaAccess;

        public ResourceDefinition(ResourceType type, ResourceCategory category, int totalCount, bool requiresSeaAccess)
        {
            Type = type;
            Category = category;
            TotalCount = totalCount;
            RequiresSeaAccess = requiresSeaAccess;
        }
    }

    /// <summary>
    /// Fixed global resource counts from ТЗ section 1.2 (54 slots total, 3 per each of the 18 settleable regions).
    /// Fish / Shellfish / Whales need sea access, so they are restricted to Coast and Island regions
    /// (the generator in HexMapGenerator enforces this).
    /// </summary>
    public static class ResourceCatalog
    {
        public static readonly ResourceDefinition[] All =
        {
            // Food — 24
            new(ResourceType.Grain, ResourceCategory.Food, 4, false),
            new(ResourceType.Livestock, ResourceCategory.Food, 4, false),
            new(ResourceType.Fruit, ResourceCategory.Food, 4, false),
            new(ResourceType.Vegetables, ResourceCategory.Food, 4, false),
            new(ResourceType.Fish, ResourceCategory.Food, 4, true),
            new(ResourceType.Shellfish, ResourceCategory.Food, 4, true),

            // Strategic — 18
            new(ResourceType.MetalOre, ResourceCategory.Strategic, 4, false),
            new(ResourceType.Silicates, ResourceCategory.Strategic, 4, false),
            new(ResourceType.Hydrocarbons, ResourceCategory.Strategic, 3, false),
            new(ResourceType.PreciousMetals, ResourceCategory.Strategic, 3, false),
            new(ResourceType.Uranium, ResourceCategory.Strategic, 2, false),
            new(ResourceType.RareEarth, ResourceCategory.Strategic, 2, false),

            // Trade — 12
            new(ResourceType.Spices, ResourceCategory.Trade, 3, false),
            new(ResourceType.Cotton, ResourceCategory.Trade, 3, false),
            new(ResourceType.Fur, ResourceCategory.Trade, 3, false),
            new(ResourceType.Whales, ResourceCategory.Trade, 3, true),
        };

        public const int TotalResourceSlots = 54;
    }
}
