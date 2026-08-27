using System.Collections.Generic;

namespace Civa.Map
{
    /// <summary>
    /// Generated map: 18x24 hexes (vertical x horizontal, ТЗ 1.1) split into a 6x6 grid
    /// of 3x4-hex regions (36 regions total).
    /// </summary>
    public class MapData
    {
        public const int Width = 24;  // hexes, horizontal
        public const int Height = 18; // hexes, vertical
        public const int RegionSizeX = 4; // hexes per region, horizontal
        public const int RegionSizeY = 3; // hexes per region, vertical
        public const int RegionGridW = Width / RegionSizeX;   // 6
        public const int RegionGridH = Height / RegionSizeY;  // 6

        public RegionData[,] RegionGrid = new RegionData[RegionGridW, RegionGridH];
        public RegionData[] Regions;
        public readonly Dictionary<HexCoord, RegionData> HexToRegion = new();

        public RegionData GetRegionForHex(HexCoord c) => HexToRegion.TryGetValue(c, out var r) ? r : null;
    }
}
