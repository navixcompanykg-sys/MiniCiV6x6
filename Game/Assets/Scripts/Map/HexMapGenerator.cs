using System;
using System.Collections.Generic;
using System.Linq;

namespace Civa.Map
{
    /// <summary>
    /// Procedural generator for the world map.
    /// Region-type counts and resource counts are fixed by design (ТЗ sections 1.1, 1.2) —
    /// only their placement is randomized (seeded, reproducible).
    /// </summary>
    public static class HexMapGenerator
    {
        // Fixed region-type counts, ТЗ 1.1 (36 regions total)
        const int LandCount = 12;
        const int NeutralCityCount = 4;
        const int DesertCount = 2;
        const int OpenSeaCount = 12;
        const int CoastCount = 3;
        const int IslandCount = 3;

        public static MapData Generate(int seed)
        {
            var rng = new Random(seed);
            var map = new MapData();

            BuildGridAndRegions(map);
            AssignRegionTypes(map, rng);
            AssignResources(map, rng);

            return map;
        }

        // ---------------------------------------------------------------
        // Grid construction
        // ---------------------------------------------------------------

        static void BuildGridAndRegions(MapData map)
        {
            map.Regions = new RegionData[MapData.RegionGridW * MapData.RegionGridH];
            int id = 0;
            for (int gc = 0; gc < MapData.RegionGridW; gc++)
            {
                for (int gr = 0; gr < MapData.RegionGridH; gr++)
                {
                    var region = new RegionData { Id = id, GridCol = gc, GridRow = gr };
                    for (int dx = 0; dx < MapData.RegionSizeX; dx++)
                    {
                        for (int dy = 0; dy < MapData.RegionSizeY; dy++)
                        {
                            var hex = new HexCoord(gc * MapData.RegionSizeX + dx, gr * MapData.RegionSizeY + dy);
                            region.Hexes.Add(hex);
                            map.HexToRegion[hex] = region;
                        }
                    }
                    map.RegionGrid[gc, gr] = region;
                    map.Regions[id] = region;
                    id++;
                }
            }
        }

        // ---------------------------------------------------------------
        // Region type layout
        // ---------------------------------------------------------------
        // Grows one contiguous "continent" blob (Land+Coast+Desert+NeutralCity),
        // then classifies its cells; islands are separate sea cells kept apart from
        // the continent where possible. Region-to-region adjacency here is plain
        // orthogonal grid adjacency on the 6x6 region grid (not hex adjacency —
        // that's reserved for unit movement within a region later).

        static void AssignRegionTypes(MapData map, Random rng)
        {
            int continentSize = LandCount + CoastCount + DesertCount + NeutralCityCount; // 21
            var blob = GrowRegionBlob(map, rng, continentSize);
            var unassigned = new HashSet<RegionData>(blob);

            var coastalCandidates = blob
                .Where(r => RegionNeighbors(map, r).Any(n => !blob.Contains(n)))
                .ToList();
            Shuffle(coastalCandidates, rng);

            var coastPicked = TakeExact(coastalCandidates, unassigned, CoastCount, rng);
            foreach (var r in coastPicked) { r.Type = RegionType.Coast; unassigned.Remove(r); }

            var interiorRemaining = unassigned.Where(r => !coastalCandidates.Contains(r)).ToList();
            Shuffle(interiorRemaining, rng);
            var desertPicked = TakeExact(interiorRemaining, unassigned, DesertCount, rng);
            foreach (var r in desertPicked) { r.Type = RegionType.Desert; unassigned.Remove(r); }

            var neutralPool = unassigned.ToList();
            Shuffle(neutralPool, rng);
            var neutralPicked = TakeExact(neutralPool, unassigned, NeutralCityCount, rng);
            foreach (var r in neutralPicked) { r.Type = RegionType.NeutralCity; unassigned.Remove(r); }

            // Whatever is left of the continent blob is plain Land.
            foreach (var r in unassigned) r.Type = RegionType.Land;

            // Islands: sea cells that don't touch the continent, if available.
            var seaRegions = map.Regions.Where(r => !blob.Contains(r)).ToList();
            var nonAdjacentSea = seaRegions
                .Where(r => RegionNeighbors(map, r).All(n => !blob.Contains(n)))
                .ToList();
            var islandPool = nonAdjacentSea.Count >= IslandCount ? nonAdjacentSea : seaRegions;
            Shuffle(islandPool, rng);
            var islandPicked = islandPool.Take(IslandCount).ToList();
            foreach (var r in islandPicked) r.Type = RegionType.Island;

            // Everything else is open sea.
            foreach (var r in seaRegions.Except(islandPicked)) r.Type = RegionType.OpenSea;
        }

        static HashSet<RegionData> GrowRegionBlob(MapData map, Random rng, int targetSize)
        {
            var blob = new HashSet<RegionData>();
            var frontier = new List<RegionData>();

            var start = map.Regions[rng.Next(map.Regions.Length)];
            blob.Add(start);
            frontier.Add(start);

            while (blob.Count < targetSize)
            {
                if (frontier.Count == 0)
                {
                    // Grid exhausted from the seed point (shouldn't happen on a 6x6 grid
                    // with targetSize 21) — fall back to any unassigned cell.
                    var remaining = map.Regions.Where(r => !blob.Contains(r)).ToList();
                    var next = remaining[rng.Next(remaining.Count)];
                    blob.Add(next);
                    frontier.Add(next);
                    continue;
                }

                int idx = rng.Next(frontier.Count);
                var current = frontier[idx];
                var candidates = RegionNeighbors(map, current).Where(n => !blob.Contains(n)).ToList();
                if (candidates.Count == 0)
                {
                    frontier.RemoveAt(idx);
                    continue;
                }

                var pick = candidates[rng.Next(candidates.Count)];
                blob.Add(pick);
                frontier.Add(pick);
            }

            return blob;
        }

        /// <summary>Takes exactly `count` items from `preferred` (deduped against `pool`), topping up from `pool` if `preferred` runs short.</summary>
        static List<RegionData> TakeExact(List<RegionData> preferred, HashSet<RegionData> pool, int count, Random rng)
        {
            var picked = preferred.Where(pool.Contains).Take(count).ToList();
            if (picked.Count < count)
            {
                var fallback = pool.Except(picked).OrderBy(_ => rng.Next()).Take(count - picked.Count);
                picked.AddRange(fallback);
            }
            return picked;
        }

        static IEnumerable<RegionData> RegionNeighbors(MapData map, RegionData r)
        {
            int[,] dirs = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } };
            for (int i = 0; i < 4; i++)
            {
                int nc = r.GridCol + dirs[i, 0];
                int nr = r.GridRow + dirs[i, 1];
                if (nc >= 0 && nc < MapData.RegionGridW && nr >= 0 && nr < MapData.RegionGridH)
                    yield return map.RegionGrid[nc, nr];
            }
        }

        // ---------------------------------------------------------------
        // Resource placement
        // ---------------------------------------------------------------
        // Only settleable regions (Land, Coast, Island — 18 of them, ТЗ 1.2/9) get
        // exactly 3 resource slots each = 54, matching ResourceCatalog totals exactly.
        // Sea-access resources (Fish/Shellfish/Whales, 11 instances) can only land on
        // Coast/Island; everything else (43 instances) can land anywhere settleable.
        // The math works out exactly: Land needs 12*3=36 slots (all from the 43
        // land-ok instances), Coast+Island need (3+3)*3=18 slots (the 11 sea-access
        // instances plus the 7 land-ok instances left over) — no leftovers, no gaps.

        static void AssignResources(MapData map, Random rng)
        {
            var seaAccessBag = new List<ResourceType>();
            var landOkBag = new List<ResourceType>();
            foreach (var def in ResourceCatalog.All)
            {
                var bag = def.RequiresSeaAccess ? seaAccessBag : landOkBag;
                for (int i = 0; i < def.TotalCount; i++) bag.Add(def.Type);
            }

            Shuffle(landOkBag, rng);

            var landRegions = map.Regions.Where(r => r.Type == RegionType.Land).ToList();
            var coastIslandRegions = map.Regions.Where(r => r.Type == RegionType.Coast || r.Type == RegionType.Island).ToList();

            int landSlots = landRegions.Count * 3;
            var forLand = landOkBag.Take(landSlots).ToList();
            var leftoverLandOk = landOkBag.Skip(landSlots).ToList();

            var forCoastIsland = new List<ResourceType>(seaAccessBag);
            forCoastIsland.AddRange(leftoverLandOk);
            Shuffle(forCoastIsland, rng);

            DistributeThreePerRegion(landRegions, forLand, rng);
            DistributeThreePerRegion(coastIslandRegions, forCoastIsland, rng);
        }

        /// <summary>Hands out exactly 3 resources per region from `bag` (bag.Count must equal regions.Count*3), avoiding same-type duplicates within a region where possible.</summary>
        static void DistributeThreePerRegion(List<RegionData> regions, List<ResourceType> bag, Random rng)
        {
            var pending = new List<ResourceType>(bag);
            Shuffle(pending, rng);

            foreach (var region in regions)
            {
                while (region.Resources.Count < 3 && pending.Count > 0)
                {
                    int idx = pending.FindIndex(t => !region.Resources.Contains(t));
                    if (idx < 0) idx = 0; // only duplicates left for this region — accept one
                    region.Resources.Add(pending[idx]);
                    pending.RemoveAt(idx);
                }
            }
        }

        static void Shuffle<T>(IList<T> list, Random rng)
        {
            for (int i = list.Count - 1; i > 0; i--)
            {
                int j = rng.Next(i + 1);
                (list[i], list[j]) = (list[j], list[i]);
            }
        }
    }
}
