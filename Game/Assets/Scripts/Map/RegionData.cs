using System.Collections.Generic;

namespace Civa.Map
{
    /// <summary>One 4x3-hex region block (36 of these tile the map in a 6x6 grid).</summary>
    public class RegionData
    {
        public int Id;
        public int GridCol; // 0..5
        public int GridRow; // 0..5
        public RegionType Type = RegionType.OpenSea;
        public readonly List<HexCoord> Hexes = new();
        public readonly List<ResourceType> Resources = new(); // 0 or exactly 3, see RegionRules.GetsResources
    }
}
