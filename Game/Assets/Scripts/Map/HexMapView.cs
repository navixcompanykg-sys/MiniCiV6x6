using System.Collections.Generic;
using UnityEngine;

namespace Civa.Map
{
    /// <summary>
    /// Generates a map and builds it as a single colored mesh (flat-top hexes, tinted
    /// by region type, with small square markers for resource slots). Real per-hex
    /// art/tiles can replace this later — this exists so the generator's output is
    /// actually visible in Scene/Game view, not just debug gizmos.
    /// </summary>
    [RequireComponent(typeof(MeshFilter), typeof(MeshRenderer))]
    public class HexMapView : MonoBehaviour
    {
        [SerializeField] int seed = 12345;
        [SerializeField] float hexSize = 0.5f;
        [SerializeField] Material material;

        public MapData Map { get; private set; }
        public Bounds MeshBounds { get; private set; }

        void Start()
        {
            if (Map == null) Generate();
        }

        [ContextMenu("Generate Now")]
        public void Generate()
        {
            Map = HexMapGenerator.Generate(seed);
            BuildMesh();
        }

        Vector3 HexToWorld(HexCoord c)
        {
            float horiz = hexSize * 1.5f;
            float height = Mathf.Sqrt(3f) * hexSize;
            float x = horiz * c.Col;
            float y = height * (c.Row + 0.5f * (c.Col & 1));
            return new Vector3(x, y, 0f);
        }

        static Color ColorFor(RegionType type) => type switch
        {
            RegionType.Land => new Color(0.36f, 0.62f, 0.29f),
            RegionType.NeutralCity => new Color(0.85f, 0.78f, 0.25f),
            RegionType.Desert => new Color(0.82f, 0.66f, 0.36f),
            RegionType.OpenSea => new Color(0.15f, 0.35f, 0.65f),
            RegionType.Coast => new Color(0.30f, 0.65f, 0.75f),
            RegionType.Island => new Color(0.55f, 0.35f, 0.65f),
            _ => Color.magenta,
        };

        static Color ColorFor(ResourceCategory cat) => cat switch
        {
            ResourceCategory.Food => Color.green,
            ResourceCategory.Strategic => new Color(0.75f, 0.75f, 0.75f),
            ResourceCategory.Trade => new Color(1f, 0.84f, 0f),
            _ => Color.white,
        };

        void BuildMesh()
        {
            var verts = new List<Vector3>();
            var colors = new List<Color>();
            var tris = new List<int>();

            foreach (var region in Map.Regions)
            {
                var regionColor = ColorFor(region.Type);
                foreach (var hex in region.Hexes)
                    AddHex(HexToWorld(hex), hexSize * 0.92f, regionColor, verts, colors, tris);

                if (region.Resources.Count > 0)
                {
                    var center = HexToWorld(RegionCenterHex(region));
                    for (int i = 0; i < region.Resources.Count; i++)
                    {
                        var def = System.Array.Find(ResourceCatalog.All, d => d.Type == region.Resources[i]);
                        var markerColor = ColorFor(def.Category);
                        var offset = new Vector3((i - 1) * hexSize * 0.4f, -hexSize * 0.15f, -0.01f);
                        AddMarker(center + offset, hexSize * 0.1f, markerColor, verts, colors, tris);
                    }
                }
            }

            var mesh = new Mesh { name = "HexMapMesh" };
            if (verts.Count > 60000) mesh.indexFormat = UnityEngine.Rendering.IndexFormat.UInt32;
            mesh.SetVertices(verts);
            mesh.SetColors(colors);
            mesh.SetTriangles(tris, 0);
            mesh.RecalculateBounds();
            mesh.RecalculateNormals();

            GetComponent<MeshFilter>().sharedMesh = mesh;
            var mr = GetComponent<MeshRenderer>();
            if (material != null) mr.sharedMaterial = material;

            MeshBounds = mesh.bounds;
        }

        static void AddHex(Vector3 center, float size, Color color, List<Vector3> verts, List<Color> colors, List<int> tris)
        {
            int baseIdx = verts.Count;
            verts.Add(center);
            colors.Add(color);
            for (int i = 0; i < 6; i++)
            {
                float angle = Mathf.Deg2Rad * (60f * i); // flat-top: corners at 0,60,120,...
                verts.Add(center + new Vector3(size * Mathf.Cos(angle), size * Mathf.Sin(angle), 0f));
                colors.Add(color);
            }
            for (int i = 0; i < 6; i++)
            {
                tris.Add(baseIdx);
                tris.Add(baseIdx + 1 + i);
                tris.Add(baseIdx + 1 + (i + 1) % 6);
            }
        }

        static void AddMarker(Vector3 center, float size, Color color, List<Vector3> verts, List<Color> colors, List<int> tris)
        {
            int baseIdx = verts.Count;
            verts.Add(center + new Vector3(-size, -size, 0)); colors.Add(color);
            verts.Add(center + new Vector3(size, -size, 0)); colors.Add(color);
            verts.Add(center + new Vector3(size, size, 0)); colors.Add(color);
            verts.Add(center + new Vector3(-size, size, 0)); colors.Add(color);
            tris.Add(baseIdx); tris.Add(baseIdx + 1); tris.Add(baseIdx + 2);
            tris.Add(baseIdx); tris.Add(baseIdx + 2); tris.Add(baseIdx + 3);
        }

        static HexCoord RegionCenterHex(RegionData region)
        {
            int col = region.GridCol * MapData.RegionSizeX + MapData.RegionSizeX / 2;
            int row = region.GridRow * MapData.RegionSizeY + MapData.RegionSizeY / 2;
            return new HexCoord(col, row);
        }
    }
}
