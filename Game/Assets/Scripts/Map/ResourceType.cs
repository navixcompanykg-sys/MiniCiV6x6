namespace Civa.Map
{
    public enum ResourceCategory
    {
        Food,
        Strategic,
        Trade,
    }

    /// <summary>All 16 resource types from ТЗ section 1.2.</summary>
    public enum ResourceType
    {
        // Food (24 slots)
        Grain,
        Livestock,
        Fruit,
        Vegetables,
        Fish,
        Shellfish, // Крабы/Моллюски

        // Strategic (18 slots)
        MetalOre,
        Silicates,
        Hydrocarbons,
        PreciousMetals,
        Uranium,
        RareEarth,

        // Trade (12 slots)
        Spices,
        Cotton,
        Fur,
        Whales,
    }
}
