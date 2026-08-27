namespace Civa.Map
{
    /// <summary>
    /// Region biome types. Distribution across the map is fixed by design (ТЗ, section 1.1):
    /// Land 12, NeutralCity 4, Desert 2, OpenSea 12, Coast 3, Island 3 = 36 regions total.
    /// </summary>
    public enum RegionType
    {
        Land,
        NeutralCity,
        Desert,
        OpenSea,
        Coast,
        Island,
    }

    public static class RegionRules
    {
        /// <summary>Regions a player can found a new city on from scratch (ТЗ 1.2, 9: 18 regions).</summary>
        public static bool IsSettleable(RegionType t) =>
            t == RegionType.Land || t == RegionType.Coast || t == RegionType.Island;

        /// <summary>Only settleable regions carry resource slots (ТЗ 1.2: 54 slots / 18 regions).</summary>
        public static bool GetsResources(RegionType t) => IsSettleable(t);

        public static bool HasSeaAccess(RegionType t) =>
            t == RegionType.Coast || t == RegionType.Island || t == RegionType.OpenSea;
    }
}
