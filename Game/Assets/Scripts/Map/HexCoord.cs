using System.Collections.Generic;

namespace Civa.Map
{
    /// <summary>
    /// Offset coordinate of a single hex tile (flat-top, "odd-q" layout: odd columns pushed down half a hex).
    /// Col grows east (0..Width-1), Row grows south (0..Height-1).
    /// </summary>
    public readonly struct HexCoord : System.IEquatable<HexCoord>
    {
        public readonly int Col;
        public readonly int Row;

        public HexCoord(int col, int row)
        {
            Col = col;
            Row = row;
        }

        static readonly int[,] EvenColDirs =
        {
            { 1, 0 }, { 1, -1 }, { 0, -1 },
            { -1, -1 }, { -1, 0 }, { 0, 1 },
        };

        static readonly int[,] OddColDirs =
        {
            { 1, 1 }, { 1, 0 }, { 0, -1 },
            { -1, 0 }, { -1, 1 }, { 0, 1 },
        };

        public IEnumerable<HexCoord> Neighbors()
        {
            var dirs = (Col & 1) == 0 ? EvenColDirs : OddColDirs;
            for (int i = 0; i < 6; i++)
                yield return new HexCoord(Col + dirs[i, 0], Row + dirs[i, 1]);
        }

        public bool Equals(HexCoord other) => Col == other.Col && Row == other.Row;
        public override bool Equals(object obj) => obj is HexCoord other && Equals(other);
        public override int GetHashCode() => (Col * 397) ^ Row;
        public override string ToString() => $"({Col},{Row})";
    }
}
